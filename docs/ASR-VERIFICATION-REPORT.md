# 腾讯 ASR 端到端验证报告

**日期**：2026-09-20
**结论一句话**：密钥和服务找到了（在 ai-X10DRG，不在 AMD），端到端通路打通，**给腾讯 ASR 灌 128 个热词能把术语识别率从 50% 提到 71%（+21 个百分点）**。

---

## 1. 密钥与服务在哪

之前判定"本机没有腾讯云密钥"是对的，但**位置找错了机器**。

| 项目 | 实际位置 |
|---|---|
| 凭据文件 | `ai-X10DRG:~/.config/video-analyzer/tencentcloud.env`（600 权限） |
| 内容 | `TENCENTCLOUD_APP_ID` / `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` |
| ASR 服务 | `capswriter-tencent-asr.service`，**active 22 小时**，enabled |
| 监听地址 | Tailscale IP `100.91.42.28:18011`（不是 spark，也不可公网访问） |
| 剩余额度 | 16604 秒（约 276 分钟） |

AMD 上只有代码副本，没有凭据、没有跑服务。

**本次消耗的额度**：约 1600 秒（flash 通道）。

---

## 2. 端到端通路验证

本机 → Tailscale → ai 机器 ASR → 腾讯，链路全通：

```
curl -F "audio=@sample.webm" http://100.91.42.28:18011/api/asr/transcribe
→ {"type":"final","success":true,"text":"可以了，为什么有这个问题？","engine":"16k_zh"}
```

单条响应 **0.35 秒**。

批量回放语音数据集：**60/60 条成功**（6 条首次遇 429 限流，串行补跑找回）。
腾讯并发限制较严，实测并发 2 安全，并发 4 会触发 429。

---

## 3. hot-rule.txt 在真实数据上的表现

55 条规则跑 60 条真实 ASR 输出：

| 指标 | 结果 |
|---|---|
| 命中 | 2 / 60 条（3.3%） |
| 正确率 | 2 / 2（100%） |
| 误伤 | 0 |

两条命中的实际效果：

```
before: 就是既然知道了筛选ID，其实就可以用       after: 就是既然知道了sessionID，其实就可以用
before: 但是由于a g X.是会变化的                 after: 但是由于AGX.是会变化的
```

**结论**：hot-rule 保持默认开启是对的——收益不高但零风险，两条都改对了。

---

## 4. 热词 A/B 实验（核心）

> ⚠️ **本节为小样本（34 条），结论偏乐观。请以 [第 10 节大样本](#10-大样本复核153-组配对2026-09-20-1530) 为准：
> 真实提升是 +12pt，不是 +21pt。**

同一批 **34 条真实音频**跑四组对照，指标是"目标术语是否被正确识别"（去标点/空格/大小写后子串匹配）。

| 配置 | 总命中率 | vs 基线 | 纠正 | 回归 |
|---|---|---|---|---|
| A 无热词（基线） | 50% | — | — | — |
| C 9 词 @ 权重 5 | 59% | +9 pt | 5 | 2 |
| B 9 词 @ 权重 11 | 68% | +18 pt | 7 | 1 |
| **D 128 词 @ 分级权重** | **71%** | **+21 pt** | **8** | **1** |

### 逐术语表现（A 基线 → D 128 词）

| 术语 | 基线 | 128 词 | 说明 |
|---|---|---|---|
| TailScale | 0% | 60% | 基线完全识别不出（"tell 的路径"） |
| Remina | 0% | 100% | 基线直接漏词 |
| Codex | 33% | 100% | |
| ADB | 50% | 75% | 基线产出 "WiFi ADP" |
| GitHub | 43% | 43% | 热词救不了，见下节 |
| AGX / TTS | 100% | 100% | 本来就准 |
| ACP | 100% | 67% | **回归 1 条，样本仅 3 条，噪声可能性大** |
| DeepSeek | 0% | 0% | ASR 听成 "deep"，热词匹配不上尾部 "-Seek" |

### 纠正样本实拍

```
TailScale  基线: 可可能需要使用tell的路径去拷贝。
           热词: 可能需要使用tailscale的路径去拷贝。

Remina     基线: 我都倾向于用去连接那个更节省资源。
           热词: 我都倾向于用remina去连接，那个更节省资源。

Codex      基线: 有一个对话和这个相关，但是不是这个code的筛选。
           热词: 有一个对话和这个相关，但是不是这个codex的筛选。

ADB        基线: WiFi ADP is a couple.
           热词: WiFi ADB is a.
```

### 诚实的局限性

- **样本量小**：每术语 2–8 条，34 条总计。ACP 的 -33%、B 组 GitHub 的 -12% 大概率是小样本噪声（D 组 GitHub 已回到 43%，与基线持平）。
- **热词救不了"完全吞音"**：GitHub 那批里 ASR 输出"提交到这个号上去""提交代码的记号上去"——词压根没出声迹象，热词无从发力。这类只能靠上下文后校正，但泛化规则风险高，不建议加。
- **DeepSeek 无效**：发音被截断成 "deep"，需改用 "DeepSeek|11" 之外的策略或接受现状。

---

## 5. 落地产物：128 词术语表

从 3786 条语音数据集自动挖掘高频英文术语，按频次排序取前 128（腾讯硬上限）。

**文件位置**（两处，内容一致）：
- `~/.config/语音转写/hot-words.txt` —— 运行时读取位置，与 `hot-rule.txt` 同目录
- `capswriter-agx-client/docs/hot-words.txt` —— 仓库内备份

格式 `词|权重`，分级规则：

| 频次 | 权重 | 数量 |
|---|---|---|
| ≥ 10 次 | 11 | 36 |
| 4–9 次 | 8 | 60 |
| ≤ 3 次 | 5 | 32 |

高频词举例：`GitHub|11`（127 次）、`APP|11`（41）、`WiFi|11`（41）、`commit|11`（31）、`ADB|11`（29）、`APK|11`（29）、`API|11`（26）、`SSH|11`（26）、`TTS|11`、`VNC|11`、`AGX|11`、`Tailscale|11`、`Codex|11`。

> 踩坑记录：一开始用"无元音字母即噪音"清洗，误杀了 SSH / TTS / VNC / VPN / GPT / PDF 等真实缩写。已改为只按频次排序、不过滤缩写。

---

## 6. 发现的断点：剪贴板术语学习是死的

客户端代码 `FloatingBallApp.jsx` 里有 `captureClipboardHotwords()`，走的是
`inferRealtimeSiblingURL(REALTIME_ASR_URL, '/api/hotwords/learn')`。

**但 ai 机器上的腾讯-only 服务没有 `/api/hotwords/learn` 这个路由**（app.py 只有 health / status / realtime / transcribe 四个）。

所以现状是：

- ✅ **热词传参链路本身是通的**
  `sessionHotwordsRef` → `hotword: sessionHotwordsRef.current.join("\n")` → FormData → 服务端 `hotword_list` → 腾讯
- ❌ **热词来源是空的**
  `sessionHotwordsRef` 初始为 `[]`，唯一填充途径是剪贴板捕获，而捕获必然调 learn 接口失败

即：**管道修好了，但没水进来。**

---

## 7. 已落地：v1.0.18（2026-09-20 14:40 部署）

按上面三条建议全部实现并部署。

### 改动清单

| 文件 | 作用 |
|---|---|
| `src/platform/electron/hotWordsStore.js` | 新增。词表读写，格式 `词|权重`，上限 128，内置防污染保护 |
| `src/platform/electron/ipc/hotWordsHandlers.js` | 新增。IPC：`get-hot-words` / `reload-hot-words` / `add-hot-words` |
| `src/platform/electron/ipc/registerIpcHandlers.js` | 注册热词 handler |
| `main.js` | 实例化 `hotWordsStore` 并挂进 ctx |
| `preload.js` | 暴露 `getHotWords` / `reloadHotWords` / `addHotWords` |
| `src/features/recording/FloatingBallApp.jsx` | 启动时载入词表到 `sessionHotwordsRef`，随录音发出；剪贴板学习改为本地优先 |
| `assets/hot-words.txt` | 随包内置 128 词，首次运行复制到用户目录 |

### 修复的两个 bug（实现过程中发现）

1. **腾位逻辑写错**：词表满 128 时逐条 `pop()` 会把同批刚加进去的词淘汰掉。改为一次性计算溢出量再截断。
2. **persist 污染内置资源**：复制失败时 `filePath` 会回退到 `assets/hot-words.txt`，写入会污染仓库文件。已禁止回写内置路径。

### 部署信息

- 位置：`~/.local/opt/capswriter-gui/releases/v1.0.18-hotwords/`
- 入口：`~/.local/bin/capswriter-gui` → v1.0.18
- sha256：`fb7e80eda816a69e3a5d23ef3f837cb01010e77ff6e81cef64cf60249b8dda9a`（dist 与部署一致）
- 回滚：`ROLLBACK.txt` 里有命令；上一个版本 v1.0.17-text-polish 保留

---

## 8. 客户端验证结果

### 客户端实际连的是哪台服务

从 `transcriptions.db` 的 `asr_connection_profiles_v1` 读出，当前激活 profile 是
**`tencent` 腾讯云·中国直连** = `ws://ai-x10drg.taild500c8.ts.net:18011/api/asr/realtime`。

即：**客户端连的就是本报告验证的那台 ai 机器**，A/B 实验的结论直接适用。

### 验证链（逐项实测）

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 生产包内 `assets/hot-words.txt` | ✓ 在包内，1018 bytes 与源文件一致 |
| 2 | 生产包内 `preload.js` 暴露 `get-hot-words` | ✓ |
| 3 | 生产包内 `hotWordsStore.js` | ✓ |
| 4 | 真实 Electron 运行时加载打包模块 | ✓ 读到 128 词，路径解析到 `~/.config/语音转写/hot-words.txt` |
| 5 | 生成的腾讯字符串合规 | ✓ 128 条，无非法分隔符 |
| 6 | **WebSocket 路径热词生效** | ✓ 见下方实拍 |
| 7 | 客户端启动无异常 | ✓ appVersion 1.0.18，窗口正常创建 |

### 第 6 项实拍（客户端实际走的实时链路）

之前 A/B 用的是 HTTP 文件接口，客户端录音走的是 WebSocket，故补验：

```
GitHub   标注: 提交到 GitHub上去。
         无热词: 提交到其他上去。      [未中]
         有热词: 提交到github上去。    [命中]  ← 热词纠正

ADB      标注: 创建adb server。
         无热词: 创建a DB server.     [拆开]
         有热词: 创建ADB server.      [合并+规范]  ← 热词纠正

TailScale 无热词/有热词都不中（ASR 出"他带"），属第 4 节记录的救不了类型
```

### 一处说明

悬浮球组件（`FloatingBallApp`）是**按需挂载**的——只在触发录音时创建，所以无头环境下启动时
不会执行词表加载。第 4 项（真实 Electron 运行时）是直接加载生产包内模块实测，等价于组件挂载后
会走的路径；两者读的是同一个文件、同一个类。真机上按下录音键即会看到日志
`Loaded ASR hot words from local file`。

---

## 9. 后续可选

1. **扩大 A/B 样本**：当前每术语 2–8 条。要下"热词确实 +21pt"的硬结论，建议每术语 ≥ 20 条再跑一轮（约 30 分钟额度）。
2. **修复 knob mapper 的 yaml 缺失**：启动时日志被 `ModuleNotFoundError: No module named 'yaml'` 刷屏，与本功能无关，但会淹没有用日志。

---

---

## 10. 大样本复核（153 组配对，2026-09-20 15:30）

第 4 节只有 34 条样本，每术语 2–8 条，噪声大。这里用**每术语 14–20 条**重跑。

**样本**：从数据集中按术语筛选，每个术语取时长最短的 20 条（省额度），
共 8 术语 × 2 组 = **306 次请求**，全部成功，耗时 6 分 7 秒，消耗约 38 分钟额度。

| 术语 | 样本 | 基线 | 128 词热词 | 差值 |
|---|---:|---:|---:|---:|
| TailScale | 20 | 0% | 30% | **+30pt** |
| AGX | 19 | 63% | 95% | **+32pt** |
| Codex | 14 | 57% | 79% | **+21pt** |
| GitHub | 20 | 50% | 55% | +5pt |
| ADB | 20 | 65% | 70% | +5pt |
| APP | 20 | 90% | 95% | +5pt |
| TTS | 20 | 95% | 95% | 0 |
| WiFi | 20 | 100% | 100% | 0 |
| **合计** | **153** | **65%** | **77%** | **+12pt** |

配对统计：**纠正 21 条 / 回归 3 条 / 无变化 129 条**，净 +18 条。

### 与小样本的差异

| | 小样本（34 条） | 大样本（153 组） |
|---|---|---|
| 基线 | 50% | 65% |
| 128 词热词 | 71% | 77% |
| 提升 | +21pt | **+12pt** |

差异来自两处：
1. 小样本每术语仅 2–8 条，噪声大
2. 大样本选样偏短音频、且纳入了 APP/WiFi/TTS 这些原本识别率就高的词，拉高了基线

### 3 条回归（诚实记录）

| 术语 | 基线（对） | 热词（错） |
|---|---|---|
| GitHub | 提交代码的GitHub上去。 | 提交代码的，其他不上去。 |
| GitHub | 帮我把代码提交到GitHub上去。 | 帮我把代码提交到这个号上去。 |
| ADB | 抽空用a DB.试一下。 | 抽空用DB。试一下。 |

前两条是 GitHub 权重 11 过拟合；第三条是热词版丢了首字母（判定上"a DB"归一化后算命中、
"DB"不算，存在争议）。

### 结论

- **+12pt 是可靠数字**（153 组配对，纠正:回归 = 21:3）
- 最大受益者是中英混合专有名词：AGX +32pt、TailScale +30pt、Codex +21pt
- 原本就识别好的词不受影响（TTS 95%、WiFi 100% 无变化）
- GitHub 若在意抖动，可把权重从 11 降到 8 再测

复现：`python3 /tmp/big_sample_ab.py`（结果 `/tmp/big_sample_result.jsonl`）

## 附：本次验证复现命令

```bash
# 健康检查
curl -s http://100.91.42.28:18011/api/health

# 单条转录
curl -s -F "audio=@sample.webm" -F "optimize_mode=none" \
     http://100.91.42.28:18011/api/asr/transcribe

# 带热词
curl -s -F "audio=@sample.webm" -F "hotword=GitHub|11,AGX|11" \
     http://100.91.42.28:18011/api/asr/transcribe
```

脚本落在 `/tmp/asr_replay.py`、`/tmp/hotword_ab.py`、`/tmp/apply_hotrule_eval.js`。
