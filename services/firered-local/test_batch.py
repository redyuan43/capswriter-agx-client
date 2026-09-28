"""假模型检查整段调用次数和取消，不运行语音准确率测试。"""
import contextlib
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from engine import Engine


class BatchTest(unittest.TestCase):
    def make_engine(self):
        engine = Engine.__new__(Engine)
        engine.vad = Mock()
        engine.asr = Mock()
        engine.asr.transcribe.return_value = [{'text': '检查录音'}]
        engine.punc = Mock()
        engine.punc.process.return_value = [{'punc_text': '检查录音。'}]
        engine.new_session(True)
        return engine

    def test_only_finish_recognizes_complete_audio_once(self):
        engine = self.make_engine()
        cancelled = threading.Event()
        torch = SimpleNamespace(inference_mode=contextlib.nullcontext,
                                cuda=SimpleNamespace(synchronize=lambda: None))
        with patch.dict(sys.modules, {'torch': torch}):
            self.assertEqual(engine.process(b'\x01\x00' * 8, False, cancelled), ('', ''))
            engine.process(b'\x02\x00' * 4, False, cancelled)
            engine.asr.transcribe.assert_not_called()
            engine.vad.detect_frame.assert_not_called()
            self.assertEqual(engine.process(b'', True, cancelled), ('检查录音。', '检查录音'))
        engine.asr.transcribe.assert_called_once()
        self.assertEqual(len(engine.asr.transcribe.call_args.args[1][0][1]), 12)
        self.assertEqual(len(engine.buffer), 0)
        self.assertIn('asr_ms', engine.timing)
        self.assertIn('punctuation_ms', engine.timing)

    def test_cancelled_recording_does_not_recognize(self):
        engine = self.make_engine()
        cancelled = threading.Event()
        cancelled.set()
        with patch.dict(sys.modules, {'torch': SimpleNamespace()}):
            self.assertEqual(engine.process(b'\x00\x00', True, cancelled), ('', ''))
        engine.asr.transcribe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
