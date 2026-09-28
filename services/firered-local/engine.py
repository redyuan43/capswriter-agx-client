"""本机模型适配：只识别、断句，不执行词库替换或 LLM 整理。"""
import os
import re
from pathlib import Path

import numpy as np


class Segmenter:
    """25 ms 窗口、10 ms 步长，保留句首缓冲和结束时未送出的尾音。"""

    def __init__(self, vad):
        self.vad = vad
        vad.reset()
        self.audio = np.empty(0, dtype=np.int16)
        self.base = self.cursor = self.total = self.committed = 0
        self.start = None

    def feed(self, pcm, finish=False):
        self.audio = np.concatenate((self.audio, np.frombuffer(pcm, dtype='<i2')))
        self.total += len(pcm) // 2
        segments = []
        while self.cursor + 400 <= self.total:
            offset = self.cursor - self.base
            event = self.vad.detect_frame(self.audio[offset:offset + 400])
            self.cursor += 160
            if event.is_speech_start:
                self.start = max(self.base, self.committed, (event.speech_start_frame - 1) * 160)
            if event.is_speech_end and self.start is not None:
                end = min(self.total, event.speech_end_frame * 160)
                segments.append(self.audio[self.start - self.base:end - self.base].copy())
                self.committed = end
                self.start = None
        if finish and self.start is not None:
            segments.append(self.audio[self.start - self.base:].copy())
            self.committed = self.total
            self.start = None
        keep = self.start if self.start is not None else max(self.base, self.cursor - 3600)
        self.audio = self.audio[keep - self.base:].copy()
        self.base = keep
        return segments


def join_text(parts):
    result = ''
    for text in parts:
        if result and re.search(r'[A-Za-z0-9]$', result) and re.match(r'[A-Za-z0-9]', text):
            result += ' '
        result += text
    return result


class Engine:
    def __init__(self):
        import torch
        from fireredasr2s.fireredasr2 import asr
        from fireredasr2s.fireredasr2.models.module import conformer_encoder, transformer_decoder
        from fireredasr2s.fireredvad import FireRedStreamVad, FireRedStreamVadConfig
        from fireredasr2s.fireredpunc import FireRedPunc, FireRedPuncConfig

        root = Path(os.environ['FIRERED_MODEL_ROOT'])
        torch.set_num_threads(4)
        if not torch.cuda.is_available():
            raise RuntimeError('FireRed2 本机服务需要可用的 CUDA')
        torch.empty(1, device='cuda')

        def load_model(filename):
            # mmap + meta 避免同时持有两份 FP32 权重；不改动已有 vendor 文件。
            package = torch.load(filename, map_location='cpu', weights_only=False, mmap=True)
            # 位置编码构造时会读取标量，必须在 CPU 生成，其他权重在 meta 构造。
            classes = [conformer_encoder.RelPositionalEncoding, transformer_decoder.PositionalEncoding]
            constructors = [cls.__init__ for cls in classes]
            def on_cpu(constructor):
                def initialize(instance, *args, **kwargs):
                    with torch.device('cpu'):
                        constructor(instance, *args, **kwargs)
                return initialize
            try:
                for cls, constructor in zip(classes, constructors):
                    cls.__init__ = on_cpu(constructor)
                with torch.device('meta'):
                    model = asr.FireRedAsrAed.from_args(package['args'])
            finally:
                for cls, constructor in zip(classes, constructors):
                    cls.__init__ = constructor
            model.load_state_dict(package['model_state_dict'], strict=True, assign=True)
            return model

        original_loader = asr.load_fireredasr_aed_model
        asr.load_fireredasr_aed_model = load_model
        try:
            self.asr = asr.FireRedAsr2.from_pretrained('aed', str(root / 'FireRedASR2-AED'),
                asr.FireRedAsr2Config(use_gpu=True, use_half=True, beam_size=3))
        finally:
            asr.load_fireredasr_aed_model = original_loader
        self.vad = FireRedStreamVad.from_pretrained(str(root / 'FireRedVAD/Stream-VAD'),
            FireRedStreamVadConfig(use_gpu=False, pad_start_frame=20,
                                   min_silence_frame=30, max_speech_frame=800))
        self.punc = FireRedPunc.from_pretrained(str(root / 'FireRedPunc'), FireRedPuncConfig(use_gpu=False))

    def new_session(self):
        self.segmenter = Segmenter(self.vad)
        self.raw_parts = []
        self.parts = []

    def process(self, pcm, finish, cancelled):
        import torch
        with torch.inference_mode():
            for audio in self.segmenter.feed(pcm, finish):
                if cancelled.is_set():
                    break
                rows = self.asr.transcribe([str(len(self.parts))], [(16000, audio)])
                if not rows:
                    raise RuntimeError('FireRed2 未返回识别结果，请检查模型日志')
                raw = rows[0].get('text', '').strip()
                if not raw:
                    continue
                punctuated = self.punc.process([raw], [str(len(self.parts))])
                self.raw_parts.append(raw)
                self.parts.append(punctuated[0]['punc_text'] if punctuated else raw)
        return join_text(self.parts), join_text(self.raw_parts)
