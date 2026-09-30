# NX6 波尔多酒红启动 logo 与 WorkBuddy 粘贴修复记录（2026-09-30）

## 一、需求与结论摘要

需求两项：

1. 把客户端启动 logo 按设计链接中的「波尔多酒红」方向换色，并在 NX6 上部署测试。
2. 排查并修复 NX6 上语音输入无法粘贴进 WorkBuddy 对话框的问题，明确是否与 Ctrl+Shift+C 或 Shift+Insert 有关，并在修复后验证两种粘贴方式。

结论：

- 启动 logo 已按 `#691E2E` 圆底 + `#F7F2EE` 象牙白 S 换色（结构、尺寸、alpha 全部不变），ARM64 包已在 NX6 本机构建、备份替换并重启，托盘图标与包内资源均已取证确认。
- **Ctrl+Shift+C 与本次问题无关**：全仓库不存在该组合（粘贴键码是 `29/42/47` = Ctrl/Shift/V，不存在 `46` = C）。真实原因是缓存里固化的 `Shift+Insert` 在 WorkBuddy 里不落字，而成功判据只看注入命令的退出码，因此永不回退、并把错误方法写回缓存。
- 修复后 WorkBuddy 家族固定走 `Ctrl+V`（实测在 WorkBuddy 输入框可用）；`Ctrl+Shift+V` 实测不落字；`Shift+Insert` 在 X11 下读的是 PRIMARY 而不是 CLIPBOARD（对照实验证据见第四节），而客户端只写 CLIPBOARD。

## 二、设计依据（用户指定链接）

页面为 SPA，实际内容在静态产物 `SIYUAN_配色迭代_v3.html`，方案名「SIYUAN · 配色第三迭代（换风格家族）」，原则为**结构不变、只换配色**。方向 II · 波尔多酒红：

| 角色 | 色值 | 用途 |
| --- | --- | --- |
| 主色 · 波尔多 | `#691E2E` | 主标识、圆底 |
| 底色 · 象牙白 | `#F7F2EE` | S 字形 |
| 强调 · 旧金 | `#A9824C` | 仅装饰（本次未叠加） |
| 深墨 · 酒窖 | `#2E0E17` | 深色底（本次未用） |

链接中提示词色 `#5C1E2D` 与实测出图色 `#691E2E` 不一致，按设计说明以 `#691E2E` 为准。酒红/象牙白对比度实测 10.35:1，与规范标注一致。

## 三、代码改动

| 文件 | 改动 |
| --- | --- |
| `assets/icon.png` | 换色：圆底 `#691E2E`、S `#F7F2EE`。512×512 与 alpha 通道逐像素不变 |
| `assets/tray-icon.png` | 同款换色，64×64。该文件同时是 Linux 发布图标来源（`daily.yml` / `release.yml` 拷贝为 `capswriter-agx-client.png`） |
| `scripts/recolor-brand-icon.py` | 新增。把素材视为旧基色（`#16A34A`、`#FFFFFF`）的线性混合，逐像素最小二乘求混合系数后重投影到新基色，因此几何与抗锯齿不变；幂等（已是新配色则跳过），`--check` 只校验 |
| `src/helpers/clipboard.js` | 新增 WorkBuddy 家族规则（WM_CLASS 命中 `workbuddy\|codebuddy\|buddycn`）：优先 `ctrl_v`，回退序 `ctrl_v → ctrl_shift_v → shift_insert`，规则覆盖旧缓存且不回写缓存；新增 `cacheIgnored` 诊断字段；ydotool/wtype 的 spawn ENOENT 结果在本进程内缓存，省掉每次约 200ms 的无效尝试 |
| `src/platform/electron/ipc/textPolishHandlers.js` | 前沿窗口白名单加入 `workbuddy`/`codebuddy`/`buddycn`：此前带换行的长口述在 WorkBuddy 里被判为「未知窗口」，只复制到剪贴板而**从不粘贴** |
| `test/brandIcon.test.js` | 新增。无第三方依赖的 PNG 解码器，断言主色为 `#691E2E`、无旧绿残留、抗锯齿像素全部落在新双色渐变上、尺寸与透明区未变 |
| `test/linuxPasteStrategy.test.js` | 新增。WorkBuddy 规则覆盖缓存、家族不写回缓存、终端/Remmina/微信/默认策略不回归、注入后端缺失只探测一次 |
| `test/speechIpc.test.js` | 扩展既有用例：`workbuddy WorkBuddy` 的多行文本允许直接粘贴 |

单测 382 → 388 项全部通过；`npm run lint` 0 error（7 个既有 warning，均不在本次改动文件内）。

## 四、粘贴问题的定位证据

### 4.1 修复前的实际行为（NX6 日志原文，`~/.config/speech-transcription/logs/app.log`）

```json
{"timestamp":"2026-09-30T02:01:59.710Z","message":"🧭 Linux 粘贴策略","data":{"windowClass":"workbuddy WorkBuddy","windowTitle":"WorkBuddy","preferredMethod":"shift_insert","source":"cache","sequence":["shift_insert","ctrl_shift_v","ctrl_v"],"targetActivationOk":true,"hasWindowMeta":true}}
{"timestamp":"2026-09-30T02:01:59.901Z","message":"⌨️ Linux 粘贴尝试","data":{"index":1,"method":"shift_insert","keyCombo":"Shift+Insert","ok":true,"code":0,"backend":"xdotool","fallbackFrom":"ydotool","fallbackError":"ydotool: spawn ydotool ENOENT","elapsedMs":191}}
```

要点：窗口识别正确、激活成功、方法是缓存里的 `shift_insert`；`xdotool` 退出码 0 即被判定成功，于是不回退到 `ctrl_shift_v`/`ctrl_v`，并把该结论写回缓存（9-29、9-30 多次记录都命中同一条缓存）。`ydotool` 未安装（NX6 上 `ydotool`/`wtype` 都不存在），每次都会先付一次 ENOENT 开销；会话类型是 X11，实际注入由 `xdotool` 完成。

### 4.2 对照实验（NX6，xterm）

- 用与客户端相同的 XTEST 注入方式在 xterm 里打字 `INJECT-OK-1151`，**成功落入**，说明注入机制本身正常。
- 同一 xterm 里把 CLIPBOARD 设成标记文本后按 `Shift+Insert`，粘出来的**不是**刚落进 CLIPBOARD 的标记，而是更早的旧选中内容 → `Shift+Insert` 在 X11 下走 PRIMARY，而客户端只写 CLIPBOARD。这是「有按键注入、但文字不出现」的直接解释。

### 4.3 WorkBuddy 输入框实测（逐字判读截图）

剪贴板条件与客户端一致（只写 CLIPBOARD），按序注入并逐次截图，输入框内容依次为：

| 步骤 | 输入框内容 | 判读 |
| --- | --- | --- |
| 起始 | `PASTEV3-1200` | 上一轮残留 |
| `Ctrl+V` | `PASTEV3-1200PASTEV1-1210` | ✅ 落字 |
| `Ctrl+Shift+V` | `PASTEV3-1200PASTEV1-1210` | ❌ 无变化，不落字 |
| `Shift+Insert` | `PASTEV3-1200PASTEV1-1210PASTEV2-1210PASTEV3-1210` | 出现标记，但把上一步 `Ctrl+Shift+V` 的标记一并带出，时序可疑，未采信 |

隔离复测（先单独测 `Ctrl+Shift+V`，再单独测 `Shift+Insert`）进行到一半时用户正在 WorkBuddy 里实际操作，窗口内容与焦点被改变，复测结论作废。因此**只把「Ctrl+V 在 WorkBuddy 输入框可用」作为已确证结论**固化到修复里；`Shift+Insert` 保留在其机制性解释（读 PRIMARY）上，不与「实测可用」等同。

## 五、NX6 部署记录

| 项 | 值 |
| --- | --- |
| 构建机 | NX6（aarch64，node v22.23.3） |
| 构建目录 | `/home/nx/.cache/capswriter-build-20260930-bordeaux`（复用既有构建目录的 arm64 node_modules） |
| 构建命令 | `npm run build:linux:agx-client` |
| 原生模块校验 | `npm run verify:appimage:native` → uiohook 与 better-sqlite3 均为 AArch64 |
| 新 AppImage | `sha256 9e3af5263603395b7a40d8e7b2ceca38462eef61614112a32b4dd55db5a51839` |
| 被替换版本 | `sha256 8c07b4edcdd849014f86098c3d2a64cc6505e4ce47f8aa9e9d1390a59b03577d`（Sep 28 15:05） |
| 备份目录 | `/home/nx/.local/share/capswriter-backups/20260930-114823-bordeaux-logo/` |
| 安装路径 | `/home/nx/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage` |
| 服务 | `capswriter-agx-client.service` active，进程已切换到新包 |
| 桌面图标 | 新增 `~/.local/share/icons/hicolor/64x64/apps/capswriter-agx-client.png`（`sha256 726306b8…`）；`~/.config/autostart/capswriter-agx-client.desktop` 的 `Icon=` 原指向已不存在的旧克隆路径，已改为图标名 |

部署包内资源校验（从**已安装**的 AppImage 里直接读 asar）：

| 包内路径 | sha256 | 判定 |
| --- | --- | --- |
| `assets/icon.png` | `e02b25a30a3d8f2807947a9e50b358897dc05672a10daedcbe5b4b1c347b360f` | 与本地新图一致 |
| `assets/tray-icon.png` | `726306b85a94389f24176e5e309e28efb1eaa283615c8f307dec20086653645f` | 与本地新图一致 |
| `src/dist/icon.png` | `e02b25a3…` | 渲染层（启动加载 logo / 悬浮球）已随包更新 |
| `src/helpers/clipboard.js` | `7eb42934fa0509a4c503533376ff987e51359e868002486a23b4f43d04c88a9e` | 粘贴修复在包内 |
| `src/platform/electron/ipc/textPolishHandlers.js` | `affc51793583cb3a16d5ebf8b9b434d949bdd7caa1305b40197a226a51136e72` | 多行投递修复在包内 |

界面取证：NX6 GNOME 顶栏托盘图标已由绿色变为波尔多酒红圆底 S（截图判读）。

## 六、生效面与未覆盖项

- 生效面：启动加载 logo（`App.jsx` 的 `LoadingLogo`）、悬浮球（`FloatingBallApp.jsx` 的 `ball-icon`）、所有 BrowserWindow 图标（`windowManager.js`）、托盘图标（`tray.js`）、Linux 发布图标与安装脚本用的 `tray-icon.png` —— 共用同一组资源，未改任何业务代码。
- 未覆盖：`assets/icon.ico` 与 `assets/icon.icns`（用户选择只改 Linux 相关资源）；启动加载页的配色样式（未选择该项）。本机 ImageMagick 不支持写出 ICNS，若需一并更新要另配工具。
- 未做端到端听写验收：本次验证到「按键与投递链路可用」这一层。请在真实场景（按住听写键说话、目标为 WorkBuddy 输入框）做一次验收，此时客户端日志应出现
  `"source":"workbuddy_rule"`、`"preferredMethod":"ctrl_v"`、`"sequence":["ctrl_v","ctrl_shift_v","shift_insert"]`、`"cacheIgnored":true`，以及 `method: "ctrl_v"` 的粘贴尝试记录；带换行的长口述应直接粘贴而不是只进剪贴板。

## 七、回滚

```bash
systemctl --user stop capswriter-agx-client.service
cp -a ~/.local/share/capswriter-backups/20260930-114823-bordeaux-logo/CapsWriter-GUI.AppImage \
      ~/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage
systemctl --user start capswriter-agx-client.service
```

需要恢复绿色图标时，删除 `~/.local/share/icons/hicolor/64x64/apps/capswriter-agx-client.png`（回滚包内自带旧图标，或重新部署备份版本）。

## 八、review 修复与 1.0.32 重新部署（2026-09-30 16:00）

### 8.1 提交前 review 的修复项

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 注释把「WorkBuddy 实测不吃 Shift+Insert」写成结论，证据不足 | `clipboard.js:10-14` 改为可复现表述：只写「缓存固化过 shift_insert + 成功判据只看退出码 + 实际落字的是 Ctrl+V」，不再断言未验证的结论 |
| 2 | Remmina 注释夹在 `}` 与 `} else if` 之间 | 移入 remmina 分支内（`clipboard.js:172-173`） |
| 3 | `chooseLinuxPasteMethods` 返回了无调用方的 `isWorkBuddyWindow` | 从返回对象删除 |
| 4 | 回退顺序的嵌套三元又深一层 | 改为 `LINUX_PASTE_FALLBACKS` 表 + `family` 变量（`clipboard.js:15-25`、`164`、`198-206`），六个家族序列与改前逐项一致 |

版本号同步 bump 到 `1.0.32`（此前 1.0.31 与已在 NX6 上的包同名同版本，无法区分）。质量门：单测 **388/388 通过**、`npm run lint` **0 error**（7 个既有 warning，均不在改动文件内）。

### 8.2 重新构建与部署

| 项 | 值 |
| --- | --- |
| 构建目录 | `/home/nx/.cache/capswriter-build-20260930-bordeaux`（复用 arm64 node_modules） |
| 产物 | `dist/CapsWriter-GUI-1.0.32-linux-arm64.AppImage` |
| 新包 sha256 | `fff20006517d4c8404a55b0ef99f96d65b56d4411dcd3c1ffd8555029eca1c2e` |
| 被替换版本 | `sha256 9e3af5263603395b7a40d8e7b2ceca38462eef61614112a32b4dd55db5a51839`（本文件第五节部署的 1.0.31 波尔多版） |
| 备份目录 | `~/.local/share/capswriter-backups/20260930-160311-bordeaux-1032/`（含旧 AppImage 与 `transcriptions.db.before-light`） |
| 原生模块 | `npm run verify:appimage:native` → uiohook 与 better-sqlite3 均 AArch64 |
| 包内资源 | `assets/icon.png` `e02b25a3…`、`assets/tray-icon.png` `726306b8…`、`src/dist/icon.png` `e02b25a3…`、`src/helpers/clipboard.js` `1865093f…`、`src/platform/electron/ipc/textPolishHandlers.js` `affc5179…`，与本地一致 |
| 服务 | `capswriter-agx-client.service` active；启动日志 `System tray created successfully`，无启动错误 |

自动整理模式：部署前已是 `light`（用户在 16:03 之前自行调回，脚本里的幂等更新为无操作）；`light` 的模型预算约 2 秒，实测上游 429 时 114–160ms 即降级。

### 8.3 端到端证据（用户 15:48 真实听写，目标 WorkBuddy）

```
15:48:53.763 🧭 Linux 粘贴策略  {"windowClass":"workbuddy WorkBuddy","preferredMethod":"ctrl_v",
             "source":"workbuddy_rule","cacheIgnored":true,"sequence":["ctrl_v","ctrl_shift_v","shift_insert"]}
15:48:53.937 ⌨️ Linux 粘贴尝试  {"method":"ctrl_v","ok":true,"backend":"xdotool",
             "fallbackError":"ydotool: unavailable (cached ENOENT)","elapsedMs":174}
15:48:53.938 📌 跳过写入粘贴方式缓存（WorkBuddy 家族由规则决定） {"method":"ctrl_v"}
15:48:53.939 Fast input paste completed {"totalMs":753,"pasteMs":380,"pasteMode":"pasted","pasteOk":true}
```

对照修复前同一窗口：`preferredMethod:"shift_insert"`、`source:"cache"`、`totalMs:30468`。修复后走的是 `workbuddy_rule` + `ctrl_v`、跳过缓存写回、`ydotool` 只探测一次（174ms），整体 753ms。

### 8.4 本次仍未覆盖

- **肉眼确认**：日志判定 `pasteMode:"pasted"`，但「文字确实出现在 WorkBuddy 输入框」仍需使用者目视确认一次（注入级测试已确证 Ctrl+V 会落入该输入框）。
- `Shift+Insert` 的隔离复测仍未被采信（此前被现场操作打断），其结论保留在机制解释层面（X11 下读 PRIMARY）。
- `audio_input_empty` 后自愈失败：15:48 两次录音失败（`bytes:0`）都伴随 `MiniJoy Bluetooth audio recovery ... spawn m5bridge-doctor ENOENT`，该自愈脚本在 NX6 上未安装；本次未纳入。
- 快速输入的整理硬预算 / 失败熔断（把「整理不许阻塞投递」固化到代码）仍未实现，等预算档位（800/1200/2000ms）确认后再做。

## 九、托盘退出卡死与 1.0.33（2026-09-30 16:2x）

### 9.1 现象与取证

用户反馈「点退出退不掉」。只读采集到的事实：

```
pid 235579  state=S  threads=2
  主线程  wchan=fuse_dev_release        ← 卡在这里
  第二线程 wchan=pipe_write
  fd 3 -> ~/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage
  fd 5 -> /dev/fuse                     ← FUSE 设备仍被占用
mount | grep mount_Caps:
  /tmp/.mount_CapsWr8JuLHT  (旧实例，已被孤儿 crashpad 占用)
  /tmp/.mount_CapsWrWbPtt0
孤儿进程: /tmp/.mount_CapsWr8JuLHT/chrome_crashpad_handler（无父进程）
日志: 16:08:50.886 "Clipboard watch stopped"（will-quit 的清理项）之后再无输出
服务: Restart=on-failure, NRestarts=0, TimeoutStopSec=10
```

即：托盘「退出」使 Electron 走完 `before-quit`/`will-quit`，最后 AppImage 运行时卸载 squashfs 时卡在 `fuse_dev_release`，进程既不再输出也不退出。那条孤儿 crashpad 由 16:03 重新部署时 SIGTERM 旧实例引入，抱着旧挂载不放，是挂死的诱因之一。

### 9.2 处置（已完成）

- 停服务（`TimeoutStopSec=10` 后 SIGKILL）+ 结束孤儿 crashpad + `fusermount -u` 清理残留挂载：最终无客户端进程、无 crashpad、残留挂载 0 条；服务处于 `failed`（已停，不会自动拉起）。
- 退出后的偶发挂载残留也一并清理：把非运行实例的 `/tmp/.mount_Caps*` 卸载干净（实测清理掉一条 `...Yn8309`），只保留运行实例自己的挂载。

### 9.3 代码修复：退出兜底看门狗

- 新增 `src/helpers/quitWatchdog.js`：`createQuitWatchdog({ app, logger, timeoutMs })` 提供 `arm/disarm/isArmed`，到点调用 `app.exit(0)`；定时器 `unref()`，不会反过来拖住正常退出；预算可由 `CAPSWRITER_QUIT_WATCHDOG_MS` 覆盖，默认 `5000ms`。
- `main.js`：`before-quit` 里 `quitWatchdog.arm()`。
- 新增 `test/quitWatchdog.test.js` 5 项（到点强制退出、重复 arm 只装一次、disarm、缺少 `app.exit` 时安全返回、预算解析）。全量单测 **393/393 通过**，`npm run lint` 0 error。

### 9.4 部署流程加固：`scripts/deploy-nx6-appimage.sh`

按序执行：停服务 → **等旧实例真正退出**（最多 15s，超时 SIGKILL）→ 结束该客户端的孤儿 crashpad → `fusermount -u` 清理残留 AppImage 挂载 → 备份（旧包 + `previous-appimage.sha256`）→ 替换 → 刷新桌面图标与 autostart 图标引用 → 启动并校验。这样不再出现「旧实例还抱着挂载就换包」的情形。

### 9.5 1.0.33 部署与验证

| 项 | 值 |
| --- | --- |
| 产物 | `CapsWriter-GUI-1.0.33-linux-arm64.AppImage` |
| 新包 sha256 | `592a77eead16fd70a59cc2e28ea75ee0d2fdc9e31051cfa4e7fc400d889b65a3` |
| 备份目录 | `~/.local/share/capswriter-backups/20260930-162039-bordeaux-1033/` |
| 原生模块 | uiohook 与 better-sqlite3 均 AArch64（`verify:appimage:native`） |
| 包内资源 | `main.js` `3688649d…`、`src/helpers/quitWatchdog.js` `e26b0489…`、`src/helpers/clipboard.js` `1865093f…`、`assets/icon.png` `e02b25a3…`，与本地一致 |
| 服务 | active，进程已切换到 1.0.33 |

验证结果：

- 一次 `systemctl --user stop` 用时 **0.46s** 干净退出，未触发看门狗（说明这次收尾没有卡），退出后无孤儿 crashpad。
- 退出后仍出现一条残留挂载，已单独卸载；说明「退出后偶发挂载残留」在 1.0.33 上依旧可能发生，靠部署脚本与手动清理兜住（看门狗只负责「进程一定能退」）。
- **托盘「退出」按钮的实测待用户点一次确认**（日志会给出两条判据：干净退出时无额外日志；若收尾再卡死，会出现 `退出收尾超时，强制结束进程` 并在 5 秒内消失）。

## 十、提交状态

改动仅在本机工作区，**未推送**（本仓库此前记录的 GitHub 认证问题依旧）。本地按三个提交整理：

1. `feat(brand): recolor startup logo to bordeaux (#691E2E / #F7F2EE)` —— `assets/icon.png`、`assets/tray-icon.png`、`scripts/recolor-brand-icon.py`、`test/brandIcon.test.js`
2. `fix(linux): prefer Ctrl+V and allow multiline paste for WorkBuddy` —— `src/helpers/clipboard.js`、`src/platform/electron/ipc/textPolishHandlers.js`、`test/speechIpc.test.js`、`test/linuxPasteStrategy.test.js`、`package.json`（1.0.32）、本文档
3. `fix(app): add quit watchdog and harden NX6 AppImage deploy` —— `main.js`、`src/helpers/quitWatchdog.js`、`test/quitWatchdog.test.js`、`scripts/deploy-nx6-appimage.sh`、`package.json`（1.0.33）、本文档

`.codebuddy/`（IDE 数据，勿删）、`artifacts/` 以及既有未跟踪文件（`.github/CODEOWNERS`、`.github/workflows/pr-gate.yml`、`.github/pull_request_template.md`、`docs/CODE-REVIEW-STANDARDS.md`、`docs/M5-serial-provision-HANDOFF.md`、`src/helpers/m5SerialDiagnose.js`）不纳入本次提交。
