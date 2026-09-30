# 代码审查标准与流程

适用仓库：`capswriter-agx-client`（Electron + React + Node，语音转写桌面客户端）
制定日期：2026-09-21 ｜ 版本：v1.0 ｜ 负责人：@redyuan43

---

## 0. 一句话结论

本仓库 10/10 个历史 PR 全部来自 `agent/*` 或 `codex/*` 分支（AI 生成），`main` 分支**无保护、无 PR 门禁、仓库对公网开放**。
因此这里要建立的**不是"多人团队互审"机制，而是"AI 生成代码的准入门禁"**——把审查成本从"读代码"前移到"卡住入口 + 强制机器验证"。

---

## 1. 现状体检（2026-09-21 实测，非估算）

| 维度 | 实测值 | 评价 |
|---|---|---|
| 源码规模 | 212 个文件（js/jsx/mjs/py），JS 部分 45,010 行 | 中等偏大 |
| 巨型文件 | 20 个 ≥500 行；最大 `FloatingBallApp.jsx` 3,546 行、`m5VoiceBridge.js` 3,166 行 | ⚠️ 难以审查 |
| 单元测试 | 398 通过 / 0 失败 / 3.7s（2026-09-30 复测） | ✅ 基础很好，可直接做门禁 |
| ESLint（现状） | `src/` 内 0 error / 6 warning | ✅ |
| **ESLint 盲区** | `main.js` `preload.js` `scripts/` `test/` `services/` **完全不在 lint 范围**，实测 21 warning | ❌ 覆盖缺口 |
| **PR 门禁 CI** | **0 个**。三个 workflow 触发条件分别是 `schedule` / `workflow_dispatch` / `push tags` | ❌ 最大漏洞 |
| 分支保护 | 未开启；仓库 **PUBLIC** | ❌ P0 |
| 凭据入库 | `.env` 已被 gitignore、未入库 ✅；源码内无真实凭据 | ✅ |
| 内网信息暴露 | `docs/` 中出现 Tailscale 内网主机名（形如 `<主机>.<tailnet>.ts.net`，本文件不再复述具体值）与若干私网 IP | ⚠️ 公开仓库可见 |
| Electron 安全基线 | `nodeIntegration:false` + `contextIsolation:true`（管理窗口另加 `sandbox:true`/`webSecurity:true`） | ✅ 做得对 |
| preload 攻击面 | 3 处 `exposeInMainWorld`，约 139 个 API 字段、138 处 ipc 调用；主进程 23 个 ipc handler | ⚠️ 面大 |
| 入参校验 | `main.js` / `windowManager.js` 中 `validate/sanitize/whitelist` **零命中** | ⚠️ |
| 注释密度 | `main.js` 3.2%（41/1288 行） | ⚠️ 偏低 |
| 调试残留 | `src`+`main`+`preload` 中 14 处 `console.log/debug/info` | ⚠️ |
| 吞异常 | 3 处 `catch (_) {}` 空块；6 处 catch 中 `error` 未使用 | ⚠️ |

---

## 2. 风险定级

| 级别 | 问题 | 影响 | 处置 |
|---|---|---|---|
| **P0** | 公开仓库 + `main` 无分支保护 | 任何人可直推；AI agent 分支可无审查合入生产代码 | 立即开启分支保护 |
| **P0** | PR 无任何自动门禁 | 398 个测试、lint 形同虚设——只在定时任务里跑 | 立即加 `pr-gate.yml` |
| **P1** | lint 只覆盖 `src/` | 主进程/脚本/测试 21 个问题长期不可见 | 本周扩展 eslint 至全仓 |
| **P1** | 巨型文件 + 大 diff | 审查者（含 AI）读不完，漏检率陡增 | 设 diff 硬上限 |
| **P2** | 注释密度低、调试残留、重复实现 | 可维护性 | 随 PR 逐步收敛 |

---

## 3. 审查标准

### 3.1 Blocker（命中即打回，不接受"下个 PR 再改"）

| # | 标准 | 本项目具体判据 |
|---|---|---|
| B1 | **不得破坏 Electron 安全边界** | 出现 `nodeIntegration: true`、`contextIsolation: false`、`sandbox: false`、`webSecurity: false` 一律打回 |
| B2 | **新增 IPC 通道必须有入参校验** | preload 已暴露 ~139 个字段。新增 `ipcMain.handle` / `contextBridge` 字段时，必须校验参数类型与取值范围；不得把任意字符串透传给 `shell`/`exec`/路径拼接 |
| B3 | **凭据与内网地址不得入库** | `.env`、`*token*`、`AKID*`、Tailscale 内网域名不得出现在 tracked 文件。已有 `docs/` 中的内网域名不再新增 |
| B4 | **禁止吞异常** | 空 `catch {}`、只 `console.log` 不记录不降级的 catch 一律打回。本项目踩过：v1.0.27/1.0.29 都在修"异常路径下录音被丢弃" |
| B5 | **禁止静默数据丢失** | 录音音频、转写结果、用户配置在**任何**中断路径（异常、超时、设备断开、进程退出）下都不得被直接丢弃，必须有 salvage/落盘/提示三选一 |
| B6 | **不得破坏既有测试** | 398 个测试必须全绿；删除或弱化断言需书面说明理由 |
| B7 | **功能修复必须附验证证据** | 录音/转写/ASR/长文本整理链路的修改，必须在 PR 描述中给出**真实回放**结果（不是手搓合成用例）。这是本项目的一条死规矩 |
| B8 | **diff 规模超限** | 单次 PR 新增行 > 800 直接拒绝，要求拆分；300–800 行必须在描述中给出逐个 commit 的说明 |

### 3.2 Major（需修改后重审）

| # | 标准 | 判据 |
|---|---|---|
| M1 | 新增文件 > 500 行需说明理由与拆分计划 | 现已有 20 个此类文件，不再增加 |
| M2 | 不得重复实现已有 helper | 提交前必须检索 `src/helpers/`；发现重复即合并 |
| M3 | 新增业务逻辑必须带测试 | 纯 UI/样式/配置除外。目标：新模块覆盖率 ≥ 60% |
| M4 | React Hook 依赖必须正确 | 现存 1 处 `exhaustive-deps` warning 待清理；新增不得再犯 |
| M5 | 错误处理必须有可观测性 | catch 中至少要 `logManager` 落日志或向用户可见反馈 |
| M6 | 不得引入无版本锁定的依赖 | 必须走 lockfile（CI 已用 `--frozen-lockfile`） |

### 3.3 Nit（可批注，不阻塞合并）

- 命名、注释（目标注释密度 ≥ 8%，关键分支必须有"为什么"的说明）
- 清除调试用 `console.log/debug/info`（现存 14 处）
- 死代码与未使用变量（现存 27 处 lint warning，随改动文件顺手清理）

---

## 4. 审查流程（四层）

```
提交前 ──► L0 作者自检 ──► L1 机器门禁(CI) ──► L2 交叉审查 ──► L3 人工终审 ──► 合入
           (作者/agent)     (自动, 强制)        (第二模型)       (原哥, 只看决策点)
```

### L0 · 作者自检（提交 PR 前必做）
- [ ] `pnpm lint` 通过
- [ ] `pnpm test` 全绿（398/398）
- [ ] `pnpm run build:renderer` 通过
- [ ] diff ≤ 300 行；超出则在描述中逐 commit 说明
- [ ] 无凭据、无内网地址进入 diff
- [ ] 录音/转写链路改动已跑真实回放，结果贴进 PR 描述
- [ ] 新增了 IPC 通道？→ 已加参数校验

### L1 · 机器门禁（CI 强制，PR 触发）
由 `.github/workflows/pr-gate.yml` 自动执行：lint → test → renderer build → diff 规模守卫 → 凭据扫描。
**任一失败即禁止合并**（需配合分支保护开启 required status check）。

### L2 · 交叉审查（AI 生成代码的必需环节）
因为本仓库 PR 100% 来自 AI 生成，**必须用与生成者不同的模型**再读一遍 diff，重点看 AI 的典型失效模式：

| AI 典型失效 | 审查动作 |
|---|---|
| 幻觉 API / 调用不存在的方法 | 逐个核对新增调用的符号是否真实存在 |
| 宽泛 try/catch 掩盖真实失败 | 见 B4，逐 catch 检查 |
| "看起来对"的抽象，边界条件缺失 | 强制问：空值？超时？设备断开？并发？ |
| 复制粘贴式重复实现 | 见 M2，全局检索 |
| 测试断言的是实现而非行为 | 检查测试是否只 mock 返回值就 pass |
| 一次性改很多文件，说明写得很漂亮但没验证 | 见 B7，必须给真实回放证据 |

### L3 · 人工终审（原哥）
**不逐行读代码**，只看四个决策点：
1. 这次改动的**意图**是否是我要的
2. L2 提出的 Blocker 是否真的解决
3. 是否动了高风险区域（见 §5 分级）
4. 真实回放证据是否可信

**时间盒**：单 PR 人工审查 ≤ 15 分钟。超过说明 diff 太大，退回拆分。

---

## 5. 分级响应矩阵（不同改动走不同强度）

| 变更区域 | L0 | L1 门禁 | L2 交叉 | L3 人工 | 额外要求 |
|---|---|---|---|---|---|
| `main.js` / `preload.js` / `windowManager.js` | ✅ | 全量 | 必做 | **必审** | 手工验证 IPC 行为 |
| 录音 / 转写 / ASR / 长文本整理链路 | ✅ | 全量 | 必做 | **必审** | **真实回放 PASS 才准合并** |
| M5 / Cardputer 设备桥接 | ✅ | 全量 | 必做 | 必审 | 真机验证 |
| 依赖升级 / 构建与发布脚本 | ✅ | 全量 | 必做 | 必审 | 冒烟 + 产物校验 |
| UI / 样式 / 设置页 | ✅ | lint+build | 抽查 | 抽查 | — |
| 文档 / 注释 | ✅ | build | 免 | 免 | — |
| 测试代码 | ✅ | 全量 | 免 | 抽查 | 不得弱化既有断言 |

---

## 6. 落地清单

### 批次 1（零风险，已完成，见随附文件）
- [x] `.github/workflows/pr-gate.yml` —— PR 触发的 lint + test + build + diff 守卫 + 凭据扫描
- [x] `.github/pull_request_template.md` —— 强制填写自检与验证证据
- [x] `.github/CODEOWNERS` —— 高风险文件强制指派

### 批次 2（需原哥操作，5 分钟）
- [ ] **开启分支保护**：Settings → Branches → `main` → 勾选
  - Require a pull request before merging
  - Require status checks to pass（勾选 `Lint + Test + Build`，必要时再加 `Diff size + secrets guard`；注意要填 job 的 **display name**，`verify` 只是 job id，填错会永远等不到 pass）
  - 建议同时 Require linear history
- [ ] **评估仓库可见性**：当前 PUBLIC 且 docs 中含 Tailscale 内网域名。要么转 private，要么清理 `docs/` 中的内网域名

### 批次 3（本周）
- [ ] 把 ESLint 提升为**仓库根级配置**：现有 `src/eslint.config.mjs` 只有 browser globals，无法覆盖 Node 侧。需拆成 renderer / node 两套 globals，使 `main.js`、`preload.js`、`scripts/`、`test/`、`services/` 纳入 lint
- [ ] 清零存量 27 个 lint warning（src 6 + 盲区 21）
- [ ] 清理 14 处调试 `console.*`

### 批次 4（持续）
- [ ] 拆分 `FloatingBallApp.jsx`(3,546) / `m5VoiceBridge.js`(3,166) / `backendAPI.js`(2,076) / `voiceActionManager.js`(1,526)
- [ ] 测试覆盖率门禁（当前无覆盖率统计，需先接入 `node --test --experimental-test-coverage`）

---

## 7. 审查 Comment 前缀约定

统一前缀，方便过滤与统计：

| 前缀 | 含义 | 是否阻塞 |
|---|---|---|
| `[blocker]` | 命中 §3.1，必须改 | 是 |
| `[major]` | 命中 §3.2，需修改后重审 | 是 |
| `[nit]` | 建议，作者可自行决定 | 否 |
| `[question]` | 需要作者解释意图 | 视回答 |
| `[praise]` | 值得保留的好做法 | 否 |

---

## 附录 A · 快速 Checklist（贴到 PR 里逐项打勾）

```
[ ] diff ≤ 300 行（300-800 需逐 commit 说明，>800 拒绝）
[ ] pnpm lint / pnpm test / build:renderer 全绿
[ ] 无凭据、无内网域名进入 diff
[ ] 无空 catch、无静默丢弃数据
[ ] 新增 IPC 已做入参校验
[ ] 未重复实现已有 helper
[ ] 新业务逻辑有测试
[ ] 录音/转写/ASR 改动已附真实回放结果
[ ] 调试 console 已清除
```
