"""标点恢复服务：常驻进程，通过标准输入输出与 Electron 主进程通信。

协议（每行一个 JSON）：
  请求 {"id":1,"text":"...","mode":"off|full"}
  响应 {"id":1,"ok":true,"text":"...","elapsed_ms":12,"mode":"off"}
  启动就绪 {"type":"ready","elapsed_ms":13670}
  错误   {"id":1,"ok":false,"error":"...","text":"<原文>"}

设计要点：
  - 不开放网络端口，只走 stdio，避免额外攻击面。
  - 模型在启动阶段加载完成（预热），之后每次请求不再付加载成本。
  - 任何异常都必须返回原文，绝不能让整理环节把用户文本弄丢。

重要实测结论（2026-09-20，本机 3786 条真实录音回归）：
  CT-Punc 接在腾讯 ASR 之后是净退化——它会吞掉英文单词间空格、删掉腾讯
  正确的顿号/问号、在长数字中间插句号。腾讯自带标点质量高于本模型。
  因此 mode 默认为 "off"；full 模式保留供后续换模型时对比评估。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "ct-punc")


def log(message):
    """日志走 stderr，避免污染 stdout 协议流。"""
    print(message, file=sys.stderr, flush=True)


class PuncService:
    def __init__(self):
        self.model = None
        self.load_error = None

    def warmup(self):
        started = time.time()
        try:
            from funasr_onnx import CT_Transformer

            self.model = CT_Transformer(MODEL_DIR, quantize=True)
            elapsed_ms = int((time.time() - started) * 1000)
            log(f"model_loaded elapsed_ms={elapsed_ms}")
            return elapsed_ms
        except Exception as error:
            self.load_error = str(error)
            log(f"model_load_failed error={error}")
            return None

    def handle(self, request):
        req_id = request.get("id")
        text = request.get("text") or ""
        mode = (request.get("mode") or "off").lower()
        started = time.time()

        # off：直接回原文，零风险（当前默认）
        if mode == "off" or not text.strip():
            return {
                "id": req_id,
                "ok": True,
                "text": text,
                "elapsed_ms": 0,
                "mode": "off",
            }

        if mode == "full":
            if self.model is None:
                return {
                    "id": req_id,
                    "ok": False,
                    "error": self.load_error or "model_unavailable",
                    "text": text,
                    "elapsed_ms": 0,
                    "mode": mode,
                }
            try:
                from punc_core import apply_punc

                result = apply_punc(self.model, text)
                return {
                    "id": req_id,
                    "ok": True,
                    "text": result,
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "mode": mode,
                }
            except Exception as error:
                log(f"punc_failed error={error}")
                return {
                    "id": req_id,
                    "ok": False,
                    "error": str(error),
                    "text": text,
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "mode": mode,
                }

        return {"id": req_id, "ok": False, "error": f"unknown_mode:{mode}", "text": text, "mode": mode}


def main():
    service = PuncService()
    elapsed_ms = service.warmup()
    print(json.dumps({"type": "ready", "elapsed_ms": elapsed_ms}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            print(json.dumps({"ok": False, "error": f"bad_request:{error}"}), flush=True)
            continue
        try:
            response = service.handle(request)
        except Exception as error:
            # 兜底：任何未捕获异常都必须把原文还回去
            log(f"unhandled error={error}")
            response = {
                "id": request.get("id"),
                "ok": False,
                "error": str(error),
                "text": request.get("text") or "",
                "mode": "off",
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
