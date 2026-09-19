# 腾讯 ASR：中国直连

客户端使用现有 CapsWriter WebSocket/HTTP 协议，AI 主机负责腾讯鉴权与适配。不加载 GPU 模型。

## 当前部署

- 源码：本目录；部署目录：AI 的 `~/services/capswriter-tencent-asr`。
- 用户服务：`capswriter-tencent-asr.service`，已配置开机启动。
- 监听：`100.91.42.28:18011`（仅 Tailscale 地址）。
- 客户端预置：**腾讯云·中国直连**，WebSocket `/api/asr/realtime`，HTTP 同一主机。
- 凭据：AI 的 `~/.config/video-analyzer/tencentcloud.env`，由 systemd 读取。不要复制到客户端、仓库或日志。
- 状态：`GET /api/status`；账本：`~/.local/share/capswriter-tencent-asr/usage.sqlite3`，只记录会话时长，不记录音频或转写文本。

腾讯 WebSocket 显式设置 `proxy=None`，HTTP 会话使用 `trust_env=False`，保留 TLS 证书验证，不固定腾讯 IP。只访问 `asr.cloud.tencent.com` 和 `asr.tencentcloudapi.com` 的大陆接口。客户端到 AI 由 Tailscale 传输。

## 引擎与额度

1. 每 60 秒通过 `DescribePidOrders` 查询账号资源包（`AvailableType=0`，分页读取）。旧的 `DescribeResource` 在当前账号返回空列表，不用于判断余额。
2. 只接受 `SubProductCode=sp_asr_realtime_prepay`、`Unit` 以 `free|` 开头且在有效期内的包；`RestNumFloat` / `RestNum` 单位为秒。此字段映射已用实际 8 秒调用的额度扣减验证。
3. 免费余量已确认时优先使用 `16k_zh`；耗尽、查询失败、没有有效资源包、数据无效或快照超过 90 秒，使用 `16k_zh_en_2.0`。
4. 录音之间选择引擎，单次录音中不切换。为并发录音预留 120 秒；接近耗尽时提前使用 2.0。因此可能剩少量免费时间，避免开始新录音后立即超额。
5. 同月余额结合本地已发送时长保守收紧，不因云端旧读数回升。重启中断的会话按至少预留时长计入。跨月必须重新取得有效免费包后才能恢复普通版。
6. 普通版握手返回 `4004` 时，尚未发送音频则改用 2.0 重试一次；音频已发送后不自动重放。认证、欠费、并发和服务错误明确返回，不购买资源包或改变付费开关。

腾讯计费存在延迟，此账本是保守的路由依据，不是精确账单。参考大陆价格：普通实时版每月 5 小时免费，后付费 3.20 元/小时；2.0 无免费额度，1 元/小时。以[官方计费文档](https://cloud.tencent.com/document/product/1093/35686)为准。

## 协议与边界

- 实时输入：`start`（`sample_rate=16000`）、单声道 PCM16 二进制、`finish` / `cancel`；输出 `ready`、`partial`、`final`、`error`。
- 音频按 200ms、1:1 速率发送腾讯；分句 `index` 的文本覆盖更新，避免 partial 重复。积压超过 10 秒明确失败；结束后等最终结果最多 12 秒。
- 同时最多 4 路实时录音、2 路文件任务；单次最长 2 小时。
- 文件接口保留 `/api/asr/transcribe`、`/api/asr/transcribe-and-optimize`、`/api/asr/transcribe-and-optimize-stream`。只支持纯转写，非 `none` 的润色/翻译请求明确失败。
- 文件使用普通极速版 `16k_zh`，独立免费额度和计费，不套用实时 2.0 切换规则。输入限 100 MB、2 小时，ffmpeg 在服务端转换为 16kHz 单声道 MP3。文件计费和微小编码填充时长以腾讯账单为准。
- 无重放式自动重试，避免重复音频、重复计费；不提供 LLM、TTS、意图识别或热词学习服务。请求热词可传逗号分隔文本或腾讯 `词|权重` 格式。
- 客户端 profile 新增可选 `httpBaseUrl`，只影响 ASR 上传和状态查询；未配置的旧 profile 仍使用原 HTTP 后端。

## 运维与验证

```bash
ssh ai 'systemctl --user status capswriter-tencent-asr.service --no-pager'
ssh ai 'journalctl --user -u capswriter-tencent-asr.service -n 30 --no-pager'
curl --noproxy '*' http://ai-x10drg.taild500c8.ts.net:18011/api/status
ssh ai 'cd ~/services/capswriter-tencent-asr && .venv/bin/python -m unittest -v test_service'
npm test
npm run build:renderer
npm run lint
```

以下命令会实际发送音频并消耗额度，必须仅使用已授权的测试样例：

```bash
ASR_REPORT_PATH=/tmp/asr-report.json node services/tencent-asr/smoke-client.cjs \
  ws://ai-x10drg.taild500c8.ts.net:18011/api/asr/realtime /path/to/synthetic.wav 20 2
```

2026-09-19：20 次 8 秒合成语音、双并发，全部成功且无 partial 回退；请求到首字 P95 789ms，结束到最终结果 P95 97ms。同期 70 秒长录音和文件上传成功。独立实例模拟额度查询失败，真实切换 2.0 成功（首字 465ms、结束到结果 59ms）；故意设置无效代理环境变量仍可直连。该测量是固定样例的连通性与延迟验证，不是多场景准确率评测。

客户端 225 项测试、服务端 15 项测试通过，AppImage 构建与原生模块架构检查通过。桌面合成麦克风输入、转写及自动粘贴验证通过；安装版连接测试通过（连接 9ms、服务准备 91ms）。安装位置为 `~/.local/opt/capswriter-gui/releases/v1.0.16-tencent-20260919/`，桌面入口已切换，原版本和切换前数据库备份保留。客户端同时修复退出时先隐藏窗口而无法结束进程的问题。

停用只需在客户端切回原 profile；服务可用 `systemctl --user stop capswriter-tencent-asr.service` 停止。保留账本，避免重新启用时重复计算免费时长。
