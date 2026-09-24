// M5 Serial Provision — 通过 USB 串口给 M5Stack/Cardputer 下发 WiFi + bridge 配置。
//
// 固件侧协议（VibeStick feature/serial-wifi-provision, vibe_serial_provision.c）：
//   发送行: VSPROV {"ssid":"...","password":"...","apply":true,"bridge":{...}}
//   应答行: VSPROV_OK {...} | VSPROV_ERR {"error":"..."}
//   探测行: VSGET  ->  VSOK {...}
// 日志输出可能与应答交错在同一 CDC 上，所以只按行前缀匹配，其它行忽略。
//
// 串口 I/O 不依赖任何原生模块：O_RDWR|O_NOCTTY|O_NONBLOCK 打开 ttyACM*，
// 先用 stty raw -echo 关掉行规程干扰，然后非阻塞轮询读。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SERIAL_BY_ID_DIR = "/dev/serial/by-id";
const ESPRESSIF_BY_ID_PREFIX = "usb-Espressif_USB_JTAG_serial_debug_unit";

const PROBE_TIMEOUT_MS = 4000;
const PROVISION_TIMEOUT_MS = 25000;
const READ_POLL_MS = 25;

const RESPONSE_PREFIXES = ["VSPROV_OK ", "VSPROV_ERR ", "VSOK "];

// ---------------------------------------------------------------------------
// 纯函数（可单测）
// ---------------------------------------------------------------------------

function buildProvisionLine(payload) {
  const ssid = String((payload && payload.ssid) || "").trim();
  if (!ssid) {
    throw new Error("ssid is required");
  }
  if (ssid.length > 32) {
    throw new Error("ssid too long (max 32)");
  }
  const password = String((payload && payload.password) || "");
  if (password.length > 64) {
    throw new Error("password too long (max 64)");
  }
  const body = {
    ssid,
    password,
    apply: (payload && payload.apply) !== false,
  };
  if (payload && payload.bridge && payload.bridge.host) {
    const host = String(payload.bridge.host).trim();
    if (host) {
      body.bridge = {
        id:
          String(payload.bridge.id || "").trim() ||
          `lan-${host.replace(/\./g, "-")}`,
        label: String(payload.bridge.label || "").trim() || "host",
        host,
        port: Number(payload.bridge.port) || 8765,
      };
    }
  }
  return `VSPROV ${JSON.stringify(body)}`;
}

function parseResponseLine(line) {
  const trimmed = String(line || "").trim();
  for (const prefix of RESPONSE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const jsonPart = trimmed.slice(prefix.length);
      let data = null;
      try {
        data = JSON.parse(jsonPart);
      } catch {
        data = null;
      }
      return { kind: prefix.trim(), data };
    }
  }
  return null;
}

function pickPrimaryLanAddress(interfaces) {
  const skipPrefixes = ["lo", "tailscale", "docker", "br-", "veth", "zt"];
  for (const name of Object.keys(interfaces || {})) {
    if (skipPrefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    for (const entry of interfaces[name] || []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      return { name, address: entry.address };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 串口 I/O
// ---------------------------------------------------------------------------

function listEspressifPorts(fsImpl = fs) {
  try {
    const entries = fsImpl.readdirSync(SERIAL_BY_ID_DIR);
    return entries
      .filter((entry) => entry.startsWith(ESPRESSIF_BY_ID_PREFIX))
      .map((entry) => ({
        path: path.join(SERIAL_BY_ID_DIR, entry),
        id: entry,
      }));
  } catch {
    return [];
  }
}

function openNonBlocking(portPath, fsImpl = fs) {
  const O_RDWR = 2;
  const O_NOCTTY = 1024;
  const O_NONBLOCK = 2048;
  try {
    const fd = fsImpl.openSync(portPath, O_RDWR | O_NOCTTY | O_NONBLOCK);
    return fd;
  } catch (error) {
    throw new Error(`无法打开串口 ${portPath}: ${error.message}`);
  }
}

function configureRawTty(portPath, spawnSyncImpl = spawnSync) {
  try {
    spawnSyncImpl("stty", ["-F", portPath, "raw", "-echo"], {
      timeout: 2000,
    });
  } catch {
    // stty 失败不致命：USB CDC 通常不依赖行规程
  }
}

function drainSerial(fd, fsImpl, options) {
  const {
    expectPrefixes,
    deadline,
    onLine,
    pollMs = READ_POLL_MS,
    sleepFn = defaultSleep,
  } = options;

  const buffer = Buffer.alloc(512);
  let pending = "";
  let matched = null;

  while (Date.now() < deadline && !matched) {
    let received = 0;
    try {
      received = fsImpl.readSync(fd, buffer, 0, buffer.length, null);
      if (received > 0) {
        pending += buffer.toString("utf8", 0, received);
      }
    } catch (error) {
      // EAGAIN = 暂无数据
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") {
        throw error;
      }
    }
    let newlineIndex;
    while ((newlineIndex = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
      pending = pending.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      if (typeof onLine === "function") {
        onLine(line);
      }
      const parsed = parseResponseLine(line);
      if (
        parsed &&
        (!expectPrefixes ||
          expectPrefixes.some((prefix) => line.startsWith(prefix)))
      ) {
        matched = parsed;
        break;
      }
    }
    if (!matched) {
      sleepFn(pollMs);
    }
  }
  return matched;
}

let defaultSleep = (ms) => {
  // Atomics.wait 在主进程可能被禁用；用同步忙等的最小实现会卡事件循环，
  // 因此这里用 Atomics.wait 若可用，否则退化为 setTimeout 由调用方 await。
  const shared = new Int32Array(new SharedArrayBuffer(4));
  try {
    Atomics.wait(shared, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // busy-wait fallback（仅在 Atomics 不可用时）
    }
  }
};

function serialTransaction(portPath, lines, options, fsImpl = fs) {
  const {
    expectPrefixes,
    timeoutMs = PROBE_TIMEOUT_MS,
    onLine = null,
  } = options || {};

  configureRawTty(portPath);
  const fd = openNonBlocking(portPath, fsImpl);
  try {
    for (const line of lines) {
      fsImpl.writeSync(fd, `${line}\n`);
    }
    const deadline = Date.now() + timeoutMs;
    return drainSerial(fd, fsImpl, {
      expectPrefixes,
      deadline,
      onLine,
    });
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// 主机侧信息收集
// ---------------------------------------------------------------------------

function detectHostBridgeTarget(osImpl = os) {
  const picked = pickPrimaryLanAddress(osImpl.networkInterfaces());
  if (!picked) {
    return null;
  }
  return { host: picked.address, port: 8765, iface: picked.name };
}

function readHostWifiProfile(spawnSyncImpl = spawnSync) {
  // 找当前激活的 WiFi 连接
  const deviceList = spawnSyncImpl(
    "nmcli",
    ["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"],
    { encoding: "utf8", timeout: 4000 }
  );
  if (deviceList.status !== 0 || !deviceList.stdout) {
    return { available: false, reason: "nmcli_unavailable" };
  }
  let wifiDevice = null;
  let connection = null;
  for (const line of deviceList.stdout.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 4) {
      continue;
    }
    const [device, type, state, connName] = parts;
    if (type === "wifi" && state === "connected" && connName) {
      wifiDevice = device;
      connection = connName;
      break;
    }
  }
  if (!wifiDevice) {
    return { available: false, reason: "no_wifi_interface" };
  }
  const ssidResult = spawnSyncImpl(
    "nmcli",
    ["-t", "-g", "802-11-wireless.ssid", "connection", "show", connection],
    { encoding: "utf8", timeout: 4000 }
  );
  const pskResult = spawnSyncImpl(
    "nmcli",
    [
      "-s",
      "-g",
      "802-11-wireless-security.psk",
      "connection",
      "show",
      connection,
    ],
    { encoding: "utf8", timeout: 4000 }
  );
  const ssid = (ssidResult.stdout || "").trim();
  const password = (pskResult.stdout || "").trim();
  if (!ssid) {
    return { available: false, reason: "ssid_unreadable" };
  }
  return {
    available: true,
    ssid,
    password,
    pskReadable: Boolean(password),
    connection,
  };
}

// ---------------------------------------------------------------------------
// 高层操作
// ---------------------------------------------------------------------------

function probeDevice(portPath, fsImpl = fs) {
  const matched = serialTransaction(
    portPath,
    ["VSGET"],
    { expectPrefixes: ["VSOK "], timeoutMs: PROBE_TIMEOUT_MS },
    fsImpl
  );
  if (!matched) {
    return { supported: false, reason: "no_response" };
  }
  return { supported: true, state: (matched.data || {}) };
}

function provisionDevice(portPath, payload, fsImpl = fs) {
  const line = buildProvisionLine(payload);
  const matched = serialTransaction(
    portPath,
    [line],
    {
      expectPrefixes: ["VSPROV_OK ", "VSPROV_ERR "],
      timeoutMs: PROVISION_TIMEOUT_MS,
    },
    fsImpl
  );
  if (!matched) {
    return { success: false, error: "timeout_no_response" };
  }
  if (matched.kind === "VSPROV_ERR") {
    return {
      success: false,
      error: (matched.data && matched.data.error) || "device_error",
    };
  }
  return { success: true, result: matched.data || {} };
}

module.exports = {
  SERIAL_BY_ID_DIR,
  ESPRESSIF_BY_ID_PREFIX,
  PROBE_TIMEOUT_MS,
  PROVISION_TIMEOUT_MS,
  RESPONSE_PREFIXES,
  buildProvisionLine,
  parseResponseLine,
  pickPrimaryLanAddress,
  listEspressifPorts,
  openNonBlocking,
  configureRawTty,
  drainSerial,
  serialTransaction,
  detectHostBridgeTarget,
  readHostWifiProfile,
  probeDevice,
  provisionDevice,
  _setDefaultSleepForTest: (fn) => {
    defaultSleep = fn;
  },
};
