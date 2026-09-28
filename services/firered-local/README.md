# NX6 本机 FireRed2

FireRed2 与腾讯直连是同层识别提供方。此服务只负责 AED 识别和模型标点（文件入口保留 VAD 切句）；热词纠正、规则、分段、GLM 整理及输入交付继续由客户端统一处理。AED 不支持此接口的原生热词注入，客户端热词仍然有效。

仅监听 `127.0.0.1:18011`，无后台界面、中心服务、音频归档、遥测或 LLM 调用。使用 NX6 已有模型和 venv，不安装或下载另一套模型。

模型懒加载：启动服务、打开设置页和轮询状态均不加载模型。首次录音、文件识别或主动测试连接时加载；任务结束或取消后连续闲置 600 秒，自动释放 AED/VAD/Punc 和 CUDA 缓存（每 5 秒检查一次）。活动任务不会被卸载。下次使用重新加载，客户端允许最多 120 秒冷启动等待。卸载保留轻量 HTTP/WS 服务及 Python/CUDA 运行时，不删除磁盘模型。

## 运行路径

- 模型及依赖：`/home/nx/weight/fireredasr2-nx4`（历史目录名，实际机器为 NX6）
- 本服务：`/home/nx/.local/opt/capswriter-firered`
- 用户服务：`capswriter-firered-local.service`
- 状态：`curl http://127.0.0.1:18011/api/health`
- 日志：`journalctl --user -u capswriter-firered-local.service -n 60`
- 停止、释放模型：`systemctl --user stop capswriter-firered-local.service`

## 客户端

在 ASR 连接中使用“FireRed2 · 本机”：

- WebSocket：`ws://127.0.0.1:18011/api/asr/realtime`
- HTTP：`http://127.0.0.1:18011`
- 认证：无

录音为 16 kHz 单声道 PCM16。WebSocket 仅将录音缓存到本机，收到松开对应的 finish 后整段调用 AED 一次，再补标点，录音中不推理、不发送 partial。ready 声明 `partial_mode=batch_on_finish`；只有 FireRed2 的该模式使用 120 秒最终等待，腾讯及其他线上路径保持原期限。整段缓存最多 4 MB（约 131 秒），超过时明确报错，不丢弃或截断音频。文件入口仍按原 VAD 分句处理。服务同时只执行一项识别任务；取消时丢弃结果，当前 GPU 运算结束后释放会话，避免串音。

HTTP 兼容 `/api/asr/transcribe`、`/api/asr/transcribe-and-optimize` 和 `-stream`。名称兼容旧协议，但服务端不执行文字优化。文件解码使用本机 ffmpeg，临时文件完成后关闭删除。

最终结果 timing 包含 `asr_ms`（GPU 同步后的纯识别）、`punctuation_ms`、`finish_to_result_ms`。客户端本地录音另记录 `stop_to_asr_result_ms`、`stop_to_text_ready_ms`；后者到文字准备完毕，不含目标应用完成粘贴的时间。服务日志只输出会话编号和耗时，不输出转写正文。

## 验证边界

`venv/bin/python test_segmenter.py` 只检查分帧、分句边界和重复文本保留，不加载模型。部署检查模型就绪、真实桌面协议的空会话和取消流程。识别质量与话筒体验由用户在 NX6 实际录音验收。

## 配套本地文字整理

选择 `firered2-local` 后，日常录音和文件转写只保留 FireRed2 标点、客户端热词、规则及列表分段，不调用大模型，忽略已保存的自动提示词模式。需要改写时，在设置的“文字整理 / 手动提示词优化”中粘贴文字，点击“手动提示词优化”，才调用 NX6 的独立 Qwen3-4B-Instruct-2507 模型；其他 ASR 配置继续自动使用免费 GLM。识别结果携带 `provider=firered2`，保证中途切换配置也不会把该段文本送往云端。本机模型失败保留规则、热词处理后的文本，不做云端回退。

- 用户服务：`capswriter-local-llm.service`
- 本机接口：`http://127.0.0.1:18087/v1/chat/completions`
- API 模型名称：`capswriter-qwen3-4b`
- 容器复用 NX6 已有 `nx6/llamacpp-ornith:jp7-mcp5-ckpt`，不改其他模型服务。
- 上下文 8192、单并发、无思考、无多模态投影；模型闲置 600 秒由 llama-server 休眠回收，后续请求唤醒。
- 本地日常输入无大模型等待，手动提示词优化总预算 60 秒；取消、原文保护、别名与规则共用原有处理。
- 权重：`~/weight/capswriter/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`，2,497,281,120 字节。
- 来源：[Unsloth 量化仓库](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)，固定 revision `a06e946bb6b655725eafa393f4a9745d460374c9`；基础模型：[Qwen 官方模型](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)。
- SHA-256：`3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`。

模型文件准备完成后，本机识别与文字整理不需要联网。运行不使用云端密钥；localhost 请求禁止重定向。模型不会写入 Git 仓库。
