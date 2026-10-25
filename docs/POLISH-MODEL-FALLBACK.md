# 逐字保真的模型选择：换掉限流的 glm-4.7-flash

## 症状

听写结果里全是碎句号，例如：

```
我们先把整个。资料。生成SBG的。找个图来。整体分析一下。
```

这些句号是 ASR 按 VAD 断点塞进来的，正常应该由 `SpeechTextFormatter` 的 light 模式
（`LIGHT_PROMPT`，只修标点、不改字）重排。它没干活，是因为上游返回错误。

## 根因

`src/helpers/speechTextFormatter.js` 里写死 `MODEL = 'glm-4.7-flash'`。实测该模型：

```
glm-4.7-flash      => ERR 1305 该模型当前访问量过大，请您稍后再试
glm-4.6-flash      => ERR 1220 您无权访问glm-4.6-flash
```

取不到结果时 `format()` 走降级分支，把原文原样交回去（`degraded: http_429 / error_code: 1305`）。
所以「整理」这一步等于不存在，碎句号就留在正文里。

## 实测对比（同一段真实录音文本、同一份 LIGHT_PROMPT）

| 端点 | 延迟 | 结果 |
| --- | --- | --- |
| `glm-4.7-flash`（原默认） | — | 1305 限流，3 次里 2 次失败 |
| `glm-4.6-flash` | — | 1220 无权限 |
| `glm-4-flash-250414` | 0.7–0.95s | 会砍字（「不合适吧」→「不合适」），被 `validateLight` 拦回原文 |
| `glm-4.5-air` | 0.8s | 断句质量最好，但偶发改词（「这个里面」→「这里面」），被拦 |
| 本机 halogen `127.0.0.1:18111` | 1.0s（首次 1.4s） | 三句全部逐字保持，标点修好 |
| nx6 vLLM `127.0.0.1:28107`（`siyuan/qwen38-v100-196k`） | 0.45s | 同上 |

结论：本机模型既快又不改字，`glm-4.5-air` 留作后备（本机引擎被 owner 停掉时兜底）。

## 配置

三个环境变量，走 systemd drop-in（**必须有 `[Service]` 段头**）：

```ini
[Service]
Environment=CAPSWRITER_POLISH_ENDPOINT=http://127.0.0.1:18111/v1/chat/completions
Environment=CAPSWRITER_POLISH_MODEL=siyuan-local
Environment=CAPSWRITER_POLISH_FALLBACK_MODEL=glm-4.5-air
```

- `_ENDPOINT` 留空 → 行为与改动前完全一致（单次请求 `open.bigmodel.cn`，模型 `glm-4.7-flash`）
- `_API_KEY` 可选；本机端点不开鉴权时不用填，也不会因此判成 `api_key_missing`
- `_FALLBACK_MODEL` 只在配了 `_ENDPOINT` 时才排队：本机连不上（引擎熄火、端口没起）
  会立刻回退到云端，整理不会整条丢掉

一键设置（幂等，带探活）：

```bash
scripts/apply-polish-endpoint.sh --restart
# nx6 上换成 vLLM：
scripts/apply-polish-endpoint.sh \
  --endpoint http://127.0.0.1:28107/v1/chat/completions \
  --model siyuan/qwen38-v100-196k --restart
# 撤销：
scripts/apply-polish-endpoint.sh --off --restart
```

## 实现要点

- **思考开关按端点类型分开**：GLM 认 `thinking: {type: 'disabled'}`；vLLM / halogen 只认
  `chat_template_kwargs: {enable_thinking: false}`。混发会被判非法参数。
- **超时**：云端 light 仍是 1800ms（与原行为一致）；自有端点给 5000ms，
  因为本机模型首字慢但总耗时稳定在 1 秒级，给足余量避免偶发超时。
- **回退预算**：第一个目标只吃 65% 预算（下限 200ms 且不超过剩余），
  剩下的留给后备，避免「主端点卡满预算、后备没机会试」。
- **逐字保真校验不变**：任何模型输出的文字被改动都会被 `validateLight` 拦下退回原文。
  这条规则是这个功能的护栏，别为了「修得更顺」把它放宽。
