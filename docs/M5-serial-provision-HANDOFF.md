# M5Stack 串口配网功能 — 交接文档

> 面向接手 Agent 的完整上下文：需求背景、已交付功能、当前痛点、待办清单、复现命令。
> 更新时间：2026-09-24 19:30（CST）

---

## 1. 需求背景

CapsWriter AGX Client 通过 USB 串口连接 M5Stack Cardputer-Adv（跑 VibeStick 固件）。
核心诉求：**客户端用串口连上设备时，自动更新设备 NVS 里的 WiFi profile 和 bridge 指向，保证设备与当前主机在同一 WiFi 网络**，从而让设备能连上主机的 CapsWriter bridge（端口 8765）做语音采集。

约束：
- 设备（ESP32-S3）**仅支持 2.4G WiFi**，不支持 5G。
- 实际网络有两个 SSID：2.4G 一个、5G 一个（同一路由器）。真实名称不入库，下文写作 `<ssid-2g>` / `<ssid-5g>`。
- 设备只能连 `<ssid-2g>`（2.4G），拿到的 IP 形如 `192.168.100.x`。

---

## 2. 涉及仓库与分支

| 仓库 | 路径 | 分支 | 关键提交 |
|---|---|---|---|
| VibeStick 固件 | `~/github/VibeStick` | `feature/serial-wifi-provision` | `b2e359b` 初版协议、`500baa9` ssid key 修复 |
| CapsWriter 客户端 | `~/github/capswriter-agx-client` | `main` | `0c5aabc` 功能、`e45546e` 路径修复、`82cf094` psk sudo 回退 |

> 注意：固件的 `wifi` 分支**原本不存在**，是从 main 从零拉出 `feature/serial-wifi-provision` 实现的，不要误以为有现成分支。

---

## 3. 已交付功能清单

### 3.1 固件侧（VibeStick）
- `firmware/sticks3/include/vibe_serial_provision.h` + `src/vibe_serial_provision.c`：
  新建 USB CDC 行协议模块。
  - `VSPROV {ssid,password,bridge,apply}` → `VSPROV_OK/ERR`：写入 WiFi profile 到 NVS，
    可选触发重连，并写 bridge registry。
  - `VSGET` → `VSOK`：返回当前连接状态（connected/ssid/ip/bridge_host/bridge_port）。
  - 协议为行协议（LF 结束），无二进制帧。
- `src/vibe_app_runtime.c`：init_wifi 后启动 provision 任务，与 serial_debug_task 互斥
  （`!defined(VIBE_SERIAL_PROVISION_ENABLED)` 条件编译）。
- `src/CMakeLists.txt`：SRCS 加入 `vibe_serial_provision.c`。
- bridge registry（`src/vibe_bridge_registry.c`）按**实际连接的 ssid** 分组存取 profile；
  `500baa9` 把 bridge 写入的 key 从"请求 ssid"改为"实际连接 ssid"（`vibe_wifi_runtime_ssid`）。

### 3.2 客户端侧（capswriter-agx-client）
- `src/helpers/m5SerialProvision.js`：无原生依赖的串口 I/O（O_NONBLOCK + stty raw），
  设备枚举、`provisionDevice`、`probeDevice`、`readHostWifiProfile`（含 sudo nmcli 回退）。
- `src/platform/electron/ipc/m5SerialProvisionHandlers.js`：4 条 IPC（list-devices /
  host-info / provision / forget-profile）。
- `preload.js`：暴露 `m5Serial*` API。
- `src/components/M5BridgePanel.jsx`（bridge tab 主面板）+ `M5SerialProvisionCard.jsx`（卡片）：
  已接入 `src/settings.jsx` 的 bridge tab。
- `src/helpers/m5SerialDiagnose.js`：独立串口诊断 CLI（**未提交**，工作区 untracked）。
  支持 `--probe` / `--grep` / `--timeout` / `--reconnect`，实时抓设备日志、
  分类 ERROR/WARN/OK/ERR、断线重连。
- `test/m5SerialProvision.test.js`：11/11 通过。

### 3.3 部署产物
- 固件 bin：`~/firmware/vibe_stick_serial_prov.bin`（初版）、
  `vibe_stick_serial_prov2.bin`（500baa9 修复版）。
- 烧录工具：`esptool`（`uvx esptool@5.4.0`），app 分区偏移 `0x20000`。
- 烧录 watcher：`autoflash.sh` / `autoflash2.sh`（app-only）。
- NX6 客户端：`~/.local/opt/capswriter-agx-client/CapsWriter-GUI.AppImage`
  （v1.0.31 arm64，含 serialprov，多份 .bak）。

---

## 4. 当前痛点（未闭环）

### 痛点 A：设备连不上 `<ssid-2g>`（2.4G），bridge 指向错
- **现象**：串口 `VSGET` 持续返回 `connected=false, ssid="", bridge_host=192.168.100.x`
  （旧主机地址），设备卡在 `Wi-Fi reconnect attempt=5` 重连循环。
- **已验证**：`<ssid-2g>` 2.4G 确实存在（3 个 BSSID，信号 100%）。
- **高度怀疑**：PSK 密码为空。客户端从 `<ssid-2g>.nmconnection` 读 psk 时，
  该连接是 **INI 格式**（非 legacy keyfile），`grep psk=` 读不到值 → 设备拿到空密码 → 连不上。
  **需确认 `.nmconnection` 真实格式并取到正确 psk。**

### 痛点 B：bridge key fallback 缺陷（固件 `500baa9`）
- `vibe_serial_provision.c:244-246` 的 fallback：设备**没连上 WiFi** 时
  `bridge_key[0]=='\0'`，回退用**请求 ssid** 作 key。
- 后果：连不上 → 永远 fallback → 即使重连成功，bridge 仍可能写到错误的 ssid key 下，
  导致设备实际连接的 2.4G ssid 下读不到新 bridge，仍轮询旧目标（AMD .142）。
- **修复方向**：连不上时不要写 bridge（或显式报告 `bridge_skipped`），
  等真正连上再用实际 ssid 写。

### 痛点 C：apply:true 触发重连导致屏幕黑屏
- `apply:true` 让设备断网重连，重连失败时设备进入启动等待态，屏幕黑屏（可恢复，重插 USB）。
- 用户原意只是"更新 WiFi AP"，不应动连接状态。
- **建议**：客户端默认 `apply:false`（只写 NVS 不重连），重连作为独立显式动作。

### 痛点 D：USB 接触不良
- 设备多次掉枚举（serial `14:C1:9F:D4:D2:48`），重插才恢复。属物理层，非软件问题。

---

## 5. 待办清单（按优先级）

1. **取到正确 PSK**：确认 `/etc/NetworkManager/system-connections/<ssid-2g>.nmconnection`
   是 INI 还是 keyfile 格式；INI 格式下用 `nmcli -s connection show <ssid-2g>` 或
   解析 `[802-11-wireless-security]` 段的 `psk=` 字段。验证客户端 `readHostWifiProfile`
   的 sudo 回退能否覆盖两种格式。
2. **修固件 bridge fallback（痛点 B）**：连不上时跳过 bridge 写入并显式回报，
   重编译 `vibe_stick_serial_prov3.bin`，重烧。
3. **客户端默认 apply:false（痛点 C）**：M5BridgePanel 配网动作默认不重连，
   提供单独的"重新连接"按钮。
4. **端到端复验**：真机配网 → 设备入网（2.4G）→ VSGET 确认
   `bridge_host=192.168.100.x` 稳定 → NX6 `/devices` 出现设备。
5. **提交未跟踪文件**：`src/helpers/m5SerialDiagnose.js`（已 node --check 通过）
   需决定是否纳入版本管理。

---

## 6. 复现 / 诊断命令速查

```bash
# 设备串口枚举
ls -l /dev/serial/by-id/ | grep Espressif

# 一次性探测（VSGET）
node ~/firmware/m5SerialDiagnose.js --probe

# 实时日志 + 断线重连 + 只看错误
node ~/firmware/m5SerialDiagnose.js --reconnect --grep "ERROR|FAIL|reconnect"

# 烧录 app（500baa9 修复版）
cd ~/firmware && chmod o+w /dev/ttyACM0
uvx esptool@5.4.0 --port /dev/ttyACM0 --baud 921600 write_flash 0x20000 vibe_stick_serial_prov2.bin

# 配网（不重连，只写 NVS）
node ~/firmware/serial-provision-cli.js provision <ssid-2g> "<PSK>" 192.168.100.x:8765 false
# 触发重连
node ~/firmware/serial-provision-cli.js provision <ssid-2g> "<PSK>" 192.168.100.x:8765 true
```

### 关键 IP 备忘（真实值不入库，按需现查）
- NX6：无线（`<ssid-5g>`）与有线各一个地址，均在 `192.168.100.0/24`
- AMD（旧 bridge）：`192.168.100.x`
- 设备（2.4G `<ssid-2g>`）：`192.168.100.x`
- 现查命令：`ip -4 addr show`、`nmcli -g IP4.ADDRESS device show`

---

## 7. 关键文件路径索引

**固件**
- `firmware/sticks3/src/vibe_serial_provision.c`（协议实现，244-246 行 fallback 待修）
- `firmware/sticks3/src/vibe_bridge_registry.c`（按 ssid 分组的 bridge 存取）
- `firmware/sticks3/src/vibe_app_runtime.c`（provision 任务启动）
- `firmware/sticks3/include/vibe_serial_provision.h`（`CONNECT_WAIT_MS 12000` 等常量）

**客户端**
- `src/helpers/m5SerialProvision.js`（底层串口 + 配网逻辑）
- `src/helpers/m5SerialDiagnose.js`（诊断 CLI，untracked）
- `src/platform/electron/ipc/m5SerialProvisionHandlers.js`（IPC）
- `src/components/M5BridgePanel.jsx`（bridge tab 面板）
- `src/settings.jsx:10,446`（面板接入点）
- `preload.js:49-52`（API 暴露）
- `test/m5SerialProvision.test.js`（11 用例）

---

## 8. 验证纪律（原哥定的死规矩）

- **改完 ≠ 完成**：凡改动配网/bridge 链路，必须真机端到端回放 PASS 才能报完成。
  离线/paper 测试不算数。
- 标准验证三场景：① 配网后设备入网；② VSGET 的 bridge_host 指向正确且稳定（连测两次）；
  ③ 主机 `/devices` 能看到设备。
- 预测失败要诚实反馈，不报假通过。
