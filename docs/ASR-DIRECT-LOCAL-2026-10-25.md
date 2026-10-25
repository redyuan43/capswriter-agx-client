# 本机直连腾讯云 ASR：为什么"直连了还是识别差"

2026-10-25 在一台 AMD 主机上把 ASR 从云端中转改成本机直连后，第一句话就被识别成
「我现在爱吃，又是说一句话。你说一下。10年的效果是不是可以？」，原话是
「我现在按右shift说一句话，你看一下，直连的效果是否可以？」。这里记录定位过程和结论。

## 一、先证明路由没问题

`~/.config/语音转写/tencent-usage.json` 里新增的 session 记录：

```
{"engine":"16k_zh","seconds":10,"state":"completed"}
```

10 秒音频整段送完、服务端 `completed`，免费额度 16493 → 16490 秒。
也就是说直连链路本身是通的，问题不在路由。

## 二、用同一段录音做单因子对照

录音原件在处理完就会被删掉，副本在 `~/Documents/CapsWriter-Voice-Dataset/<年>/<月>/assets/`。
用 `ffmpeg -f s16le` 转成裸 PCM 后逐项试：

| 条件 | 识别结果 |
| --- | --- |
| 原始电平 + `16k_zh` | 阿姨吃又吸附。/ 你说一下。 |
| +6 dB + `16k_zh` | 我现在爱是游戏。/ 你说一下。/ 10年的效果是不是可以？ |
| +12 dB + `16k_zh` | 我现在爱吃又媳妇说一句话。/ 然后你核一下直连的效果是不是可以？ |
| +12 dB + `16k_zh_en_2.0` | **我现在按一次右shift说一句话。/ 然后你核一下直连的效果是不是可以？** |
| +12 dB + 2.0 + 热词 `shift\|11` | 反而被切碎（按一次右shift。/ 说一句话。/） |

## 三、两个独立病因

1. **麦克风电平太低。** 原始录音峰值只有 -23.2 dBFS，语音段 RMS 150~200（底噪 20~30）。
   腾讯的 VAD 和编码器在这档电平下明显降质，连句子尾巴都会丢。
2. **经典版不认识中英混说。** `16k_zh` 里 "shift" 一定被抹掉，换成 `16k_zh_en_2.0`
   就能正确输出。热词救不了跨语种，加了反而让模型把句子切碎。

两个都改才有效，只改一个都还是错的。

## 四、增益怎么算

PulseAudio / PipeWire 的音量是三次方曲线：

```
amplitude = (percent / 100) ^ 3
158%  →  1.58^3 ≈ 3.95  ≈ +12 dB
```

⚠️ 不要照着线性直觉设 240% / 280%：那分别是 +22 dB / +26 dB，直接削顶。
设完用 `wpctl get-volume <id>` 或 `pactl get-source-volume <name>` 核对，
实际值会持久化到 `~/.local/state/wireplumber/default-routes` 的
`channelVolumes`，重连蓝牙后自动恢复。

## 五、一键应用

```bash
scripts/apply-tencent-direct-local.sh                 # 直连 + 2.0 + 158% 增益
scripts/apply-tencent-direct-local.sh --engine 16k_zh # 留在免费经典版
scripts/apply-tencent-direct-local.sh --gain 0        # 不动麦克风
```

凭据走 `TENCENTCLOUD_APP_ID / SECRET_ID / SECRET_KEY` 环境变量（建议 systemd drop-in），
代理绕过表必须同时包含 `asr.cloud.tencent.com` **和** `asr.tencentcloudapi.com`——
漏掉后者会让免费额度查询失败，客户端会静默降级到付费的 2.0 引擎。

## 六、验证

改完再录一句，然后看三个地方：

- `tencent-usage.json` 的 `engine` 字段是不是 `16k_zh_en_2.0`、`state` 是不是 `completed`
- 新录音的峰值是不是上到 -12 dBFS 左右（-4 dBFS 说明快到削顶了，增益该降一档）
- 直连桥在不在：主进程会额外监听一个随机高位端口，**任意路径返回 403** 就是它
