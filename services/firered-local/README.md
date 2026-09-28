# NX6 本机 FireRed2

FireRed2 与腾讯直连是同层识别提供方。此服务只负责 VAD 切句、AED 识别和模型标点；热词纠正、规则、分段、GLM 整理及输入交付继续由客户端统一处理。AED 不支持此接口的原生热词注入，客户端热词仍然有效。

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

录音为 16 kHz 单声道 PCM16。VAD 用 25 ms 窗口、10 ms 步长，停顿约 300 ms 切句，连续语音约 8 秒切一次；结束录音补齐尾句。这是分句后输出 partial，不是 AED 原生逐字流式解码。服务同时只执行一项识别任务；取消时丢弃结果，当前 GPU 运算结束后释放会话，避免串音。

HTTP 兼容 `/api/asr/transcribe`、`/api/asr/transcribe-and-optimize` 和 `-stream`。名称兼容旧协议，但服务端不执行文字优化。文件解码使用本机 ffmpeg，临时文件完成后关闭删除。

## 验证边界

`venv/bin/python test_segmenter.py` 只检查分帧、分句边界和重复文本保留，不加载模型。部署检查模型就绪、真实桌面协议的空会话和取消流程。识别质量与话筒体验由用户在 NX6 实际录音验收。
