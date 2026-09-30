#!/usr/bin/env node
"use strict";

// ---------------------------------------------------------------------------
// m5SerialDiagnose.js ——
// 用途：通过 UART 串口实时监视 M5Stack Cardputer-Adv（VibeStick）的日志与状态，
//      定位 WiFi 连接 / bridge 轮询 / 串口协议 等故障。
//
// 硬件平台：ESP32-S3（Espressif USB Serial/JTAG CDC，即 USB CDC 虚拟串口）
// 通信参数：
//   - 波特率  : 115200 8N1（USB CDC 协议层不强制，固件侧由 ESP-IDF 统一 115200）
//   - 数据位  : 8
//   - 停止位  : 1
//   - 流控    : 无
//   - 协议    : 行协议（LF 结束），VSPROV/VSGET 命令 → VSPROV_OK / VSOK 响应
//
// 用法：
//   node m5SerialDiagnose.js                     # 自动找 Espressif 端口，实时监视
//   node m5SerialDiagnose.js /dev/ttyACM0        # 指定端口
//   node m5SerialDiagnose.js --probe             # 只做一次 VSGET 探测然后退出
//   node m5SerialDiagnose.js --grep ERROR        # 只显示命中关键字的行
//   node m5SerialDiagnose.js --timeout 60        # 60 秒无数据后超时退出
//   node m5SerialDiagnose.js --reconnect         # 设备掉线后自动重连
// ---------------------------------------------------------------------------

const fs = require("fs");
const { spawnSync } = require("child_process");
// 串口枚举 / 非阻塞打开 / raw 行规程复用配网模块的同一套实现（M2：不重复实现已有 helper），
// 从此诊断与配网认的是同一个端口集合，不会再出现两处判定不一致；
// 若设备不按该前缀枚举，仍可显式指定端口：node m5SerialDiagnose.js /dev/ttyACM0
const {
  SERIAL_BY_ID_DIR,
  listEspressifPorts,
  openNonBlocking,
  configureRawTty,
} = require("./m5SerialProvision");

// ---------------------------------------------------------------------------
// 1. 串口枚举与打开
// ---------------------------------------------------------------------------

function resolvePort(argPort) {
  if (argPort) {
    if (fs.existsSync(argPort)) return argPort;
    console.error(`[ERROR] 指定端口 ${argPort} 不存在`);
    process.exit(1);
  }
  const ports = listEspressifPorts();
  if (ports.length === 0) {
    console.error(`[ERROR] 未找到 Espressif USB 串口（扫描目录 ${SERIAL_BY_ID_DIR}）`);
    console.error("  提示：确认设备 USB 已插好，并执行 ls -l /dev/serial/by-id/");
    process.exit(1);
  }
  if (ports.length > 1) {
    console.error(`[WARN] 找到多个 Espressif 端口，选第一个：`);
    for (const p of ports) console.error(`  ${p.path}`);
  }
  console.error(`[INFO] 使用端口 ${ports[0].path}`);
  return ports[0].path;
}

// USB CDC 不需要强制 stty；但加上 raw -echo 防某些驱动默认做行规程。
// 复用配网模块的 configureRawTty（USB CDC 不依赖波特率，故不再单独下发 115200 8N1）。
function prepareTty(port) {
  try {
    configureRawTty(port, spawnSync);
  } catch (error) {
    console.error(`[WARN] 设置串口 raw 模式失败（继续监视）：${error?.message || error}`);
  }
}

// 复用配网模块的非阻塞打开；失败时它已抛出带端口号的错误。
function openPort(port) {
  return openNonBlocking(port);
}

function closePort(fd) {
  try {
    fs.closeSync(fd);
  } catch (error) {
    console.error(`[WARN] 关闭串口失败（继续退出）：${error?.message || error}`);
  }
}

// ---------------------------------------------------------------------------
// 2. 数据接收与行解析
// ---------------------------------------------------------------------------

const lineBuf = { pending: "" };

/** 清空行缓冲（断开/重连以及单测需要从干净状态开始）。 */
function resetLineBuffer() {
  lineBuf.pending = "";
}

function readLines(fd, { onData = () => {}, fsRef = fs } = {}) {
  const buffer = Buffer.alloc(512);
  let totalReceived = 0;
  while (true) {
    let received = 0;
    try {
      received = fsRef.readSync(fd, buffer, 0, buffer.length, null);
      if (received > 0) {
        lineBuf.pending += buffer.toString("utf8", 0, received);
        totalReceived += received;
      }
    } catch (error) {
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") {
        throw error;
      }
      // EAGAIN：暂无数据，立即返回
      break;
    }
    // 按行切
    let idx;
    while ((idx = lineBuf.pending.indexOf("\n")) !== -1) {
      const raw = lineBuf.pending.slice(0, idx).replace(/\r$/, "");
      lineBuf.pending = lineBuf.pending.slice(idx + 1);
      if (raw) onData(raw);
    }
  }
  return totalReceived;
}

// ---------------------------------------------------------------------------
// 3. 关键字过滤与日志分级
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  /ERROR/i,
  /WARN/i,
  /CRIT/i,
  /FAIL/i,
  /TIMEOUT/i,
  /assert/i,
  /panic/i,
  /brownout/i,
  /guru/i,
  /reset/i,
  /no bridge/i,
  /lost/i,
];

function classify(line) {
  // 协议应答优先判定：VSPROV_ERR 的 JSON 里常带 "error" 字样，
  // 若先跑错误关键字模式，这类应答会被误标成 ERROR。
  if (/VSPROV_OK|VSOK/.test(line)) return "OK";
  if (/VSPROV_ERR/.test(line)) return "ERR";
  for (const re of ERROR_PATTERNS) {
    if (re.test(line)) {
      return re.source.replace(/\\d/g, "d").replace(/\\/g, "").slice(0, 12).toUpperCase();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 4. 命令下发（可选交互）
// ---------------------------------------------------------------------------

function sendCommand(fd, command) {
  const data = command.endsWith("\n") ? command : command + "\n";
  const bytes = Buffer.from(data, "utf8");
  fs.writeSync(fd, bytes, 0, bytes.length);
  return bytes.length;
}

// ---------------------------------------------------------------------------
// 5. 监视循环（含超时 + 断线重连）
// ---------------------------------------------------------------------------

function run({ port, grep, timeoutSec, probeOnly, reconnect } = {}) {
  const pollMs = 200;
  let fd = null;
  let lastDataAt = Date.now();

  const openWithRetry = () => {
    let attempts = 0;
    while (true) {
      try {
        prepareTty(port);
        fd = openPort(port);
        lineBuf.pending = "";
        return fd;
      } catch (error) {
        attempts += 1;
        if (!reconnect || attempts >= 3) {
          console.error(`[FATAL] ${error.message}`);
          process.exit(1);
        }
        console.error(`[WARN] ${error.message} — 3s 后重试…`);
        sleep(3000);
      }
    }
  };

  const sleep = (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 忙等；CLI 工具可接受
    }
  };

  const onLine = (line) => {
    if (grep && !grep.test(line)) return;
    const tag = classify(line);
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const tagStr = tag ? ` [${tag}]` : "";
    console.log(`${ts} | ${line}${tagStr}`);
    lastDataAt = Date.now();
  };

  openWithRetry();
  if (probeOnly) {
    sendCommand(fd, "VSGET");
    // 等 1.5s 收响应
    const start = Date.now();
    while (Date.now() - start < 1500) {
      readLines(fd, { onData: onLine });
      sleep(pollMs);
    }
    closePort(fd);
    process.exit(0);
  }

  console.error(`[INFO] 监视启动（grep=${grep ? grep.source : "off"}, timeout=${timeoutSec || "∞"}s, reconnect=${reconnect})`);
  console.error(`[INFO] Ctrl-C 退出。可用命令（手动在另一终端写入串口）：VSGET / VSPROV {ssid,password,bridge,apply}`);

  while (true) {
    const now = Date.now();
    if (timeoutSec && now - lastDataAt > timeoutSec * 1000) {
      console.error(`[TIMEOUT] ${timeoutSec}s 无数据，退出`);
      break;
    }
    try {
      readLines(fd, { onData: onLine });
      sleep(pollMs);
    } catch (error) {
      if (error.code === "ENXIO" || /no such file/i.test(error.message)) {
        console.error(`[WARN] 设备断开（${error.message}）`);
        closePort(fd);
        fd = null;
        if (!reconnect) {
          console.error("[INFO] 未启用重连，退出");
          break;
        }
        // 退避重连：1s 起步、每次 +1s、上限 5s，避免设备拔出后空转刷屏
        let attempt = 0;
        while (fd === null) {
          attempt += 1;
          const wait = Math.min(5000, 1000 * attempt);
          if (attempt > 1) {
            console.error(`[INFO] ${wait / 1000}s 后重试（第 ${attempt} 次）`);
          }
          sleep(wait);
          try {
            prepareTty(port);
            fd = openPort(port);
            lineBuf.pending = "";
            console.error("[INFO] 重连成功");
          } catch (error) {
            console.error(`[WARN] 重连失败：${error?.message || error}`);
          }
        }
        continue;
      }
      throw error;
    }
  }
  if (fd) closePort(fd);
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    port: null,
    grep: null,
    timeoutSec: 0,
    probeOnly: false,
    reconnect: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--probe") args.probeOnly = true;
    else if (a === "--reconnect") args.reconnect = true;
    else if (a === "--grep") {
      const pat = argv[++i];
      if (!pat) { console.error("--grep 需要模式参数"); process.exit(1); }
      try { args.grep = new RegExp(pat, "i"); }
      catch (e) { console.error(`--grep 正则无效：${e.message}`); process.exit(1); }
    } else if (a === "--timeout") {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error("--timeout 需要正整数秒"); process.exit(1);
      }
      args.timeoutSec = n;
    } else if (a === "-h" || a === "--help") {
      console.log(USAGE_TEXT);
      process.exit(0);
    } else if (!a.startsWith("-")) {
      args.port = a;
    } else {
      console.error(`未知参数 ${a}（--help 查看用法）`);
      process.exit(1);
    }
  }
  args.port = resolvePort(args.port);
  return args;
}

// 避免 require 一个不存在的 usage 模块 —— 内联文本
const USAGE_TEXT = `用法：node m5SerialDiagnose.js [port] [--grep PATTERN] [--timeout SEC] [--probe] [--reconnect]
  --probe       只做一次 VSGET 探测后退出
  --reconnect   设备掉线自动重连
  --timeout N   N 秒无数据后退出
  --grep PAT    只显示命中 PAT 的行
  port          指定串口设备路径（不填则自动找 Espressif USB CDC）`;

function main() {
  const args = parseArgs(process.argv);
  try {
    run(args);
  } catch (error) {
    console.error(`[FATAL] ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  listEspressifPorts,
  resolvePort,
  prepareTty,
  openPort,
  closePort,
  readLines,
  resetLineBuffer,
  classify,
  sendCommand,
  run,
};
