const path = require("node:path");
const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = 1;
const REPORT_TIMEOUT_MS = 750;
const DEFAULT_ALLOWED_DEVICE_IDS = "28:84:85:76:25:c0";

const HID_TO_LINUX = new Map([
  [0x04, 30], [0x05, 48], [0x06, 46], [0x07, 32], [0x08, 18], [0x09, 33],
  [0x0a, 34], [0x0b, 35], [0x0c, 23], [0x0d, 36], [0x0e, 37], [0x0f, 38],
  [0x10, 50], [0x11, 49], [0x12, 24], [0x13, 25], [0x14, 16], [0x15, 19],
  [0x16, 31], [0x17, 20], [0x18, 22], [0x19, 47], [0x1a, 17], [0x1b, 45],
  [0x1c, 21], [0x1d, 44],
  [0x1e, 2], [0x1f, 3], [0x20, 4], [0x21, 5], [0x22, 6], [0x23, 7],
  [0x24, 8], [0x25, 9], [0x26, 10], [0x27, 11],
  [0x28, 28], [0x29, 1], [0x2a, 14], [0x2b, 15], [0x2c, 57],
  [0x2d, 12], [0x2e, 13], [0x2f, 26], [0x30, 27], [0x31, 43],
  [0x33, 39], [0x34, 40], [0x35, 41], [0x36, 51], [0x37, 52], [0x38, 53],
  [0x3a, 59], [0x3b, 60], [0x3c, 61], [0x3d, 62], [0x3e, 63], [0x3f, 64],
  [0x40, 65], [0x41, 66], [0x42, 67], [0x43, 68], [0x44, 87], [0x45, 88],
  [0x4c, 111], [0x4f, 106], [0x50, 105], [0x51, 108], [0x52, 103],
]);

const MODIFIER_TO_LINUX = [
  [0x01, 29],  // Left Control
  [0x02, 42],  // Left Shift / Aa
  [0x04, 56],  // Left Alt
  [0x08, 125], // Left Meta
  [0x10, 97],  // Right Control
  [0x20, 54],  // Right Shift
  [0x40, 100], // Right Alt / Option
  [0x80, 126], // Right Meta
];

function normalizeDeviceId(value) {
  return String(value || "").trim().toLowerCase();
}

function parseAllowedDeviceIds(value = DEFAULT_ALLOWED_DEVICE_IDS) {
  return new Set(String(value || "")
    .split(",")
    .map(normalizeDeviceId)
    .filter(Boolean));
}

function helperPath() {
  if (__dirname.includes("app.asar")) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "src",
      "helpers",
      "cardputer_uinput.py"
    );
  }
  return path.join(__dirname, "cardputer_uinput.py");
}

class LinuxUinputBackend {
  constructor({ logger = null, spawnProcess = spawn } = {}) {
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.readyPromise = null;
    this.stopping = false;
  }

  async _ensureStarted() {
    if (process.platform !== "linux") {
      throw Object.assign(new Error("Cardputer keyboard injection requires Linux"), {
        statusCode: 501,
      });
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }
    this.readyPromise = new Promise((resolve, reject) => {
      const child = this.spawnProcess("python3", [helperPath()], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.stopping = false;
      this.child = child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(Object.assign(new Error("uinput helper startup timed out"), {
          statusCode: 503,
        }));
      }, 2000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          const ready = JSON.parse(stdout.slice(0, newline));
          if (ready.ready === true) finish();
          else finish(Object.assign(new Error(ready.error || "uinput unavailable"), {
            statusCode: 503,
          }));
        } catch (error) {
          finish(Object.assign(error, { statusCode: 503 }));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        finish(Object.assign(error, { statusCode: 503 }));
      });
      child.on("exit", (code) => {
        const error = Object.assign(
          new Error(stderr.trim() || `uinput helper exited with code ${code}`),
          { statusCode: 503 }
        );
        finish(error);
        this.child = null;
        this.readyPromise = null;
        if (!this.stopping) {
          this.logger?.warn?.("Cardputer uinput helper exited", {
            code,
            error: error.message,
          });
        }
      });
    });
    return this.readyPromise;
  }

  async report(codes) {
    await this._ensureStarted();
    if (!this.child?.stdin?.writable) {
      throw Object.assign(new Error("uinput helper is unavailable"), {
        statusCode: 503,
      });
    }
    this.child.stdin.write(`${JSON.stringify({ type: "report", codes })}\n`);
  }

  async releaseAll() {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify({ type: "release_all" })}\n`);
    }
  }

  stop() {
    if (!this.child) return;
    this.stopping = true;
    if (this.child.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
      this.child.stdin.end();
    }
    const child = this.child;
    const timer = setTimeout(() => child.kill("SIGTERM"), 500);
    timer.unref?.();
    this.child = null;
    this.readyPromise = null;
  }
}

class CardputerKeyboardBridge {
  constructor({
    logger = null,
    backend = null,
    allowedDeviceIds = process.env.M5_CARDPUTER_KEYBOARD_DEVICE_IDS,
    now = Date.now,
  } = {}) {
    this.logger = logger;
    this.backend = backend || new LinuxUinputBackend({ logger });
    this.allowedDeviceIds = parseAllowedDeviceIds(
      allowedDeviceIds === undefined ? DEFAULT_ALLOWED_DEVICE_IDS : allowedDeviceIds
    );
    this.now = now;
    this.state = null;
    this.watchdog = setInterval(() => this._releaseExpired(), 250);
    this.watchdog.unref?.();
  }

  status() {
    return {
      protocol_version: PROTOCOL_VERSION,
      backend: process.platform === "linux" ? "uinput" : "unsupported",
      enabled: this.allowedDeviceIds.size > 0,
      allowed_device_count: this.allowedDeviceIds.size,
    };
  }

  _validate(device, body) {
    const deviceId = normalizeDeviceId(device?.device_id);
    if (String(device?.board || "") !== "cardputer_adv" ||
        !this.allowedDeviceIds.has(deviceId)) {
      throw Object.assign(new Error("Cardputer keyboard device is not allowed"), {
        statusCode: 403,
      });
    }
    if (body?.protocol_version !== PROTOCOL_VERSION) {
      throw Object.assign(new Error("unsupported keyboard protocol"), {
        statusCode: 400,
      });
    }
    const sessionId = String(body.session_id || "").trim();
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(sessionId)) {
      throw Object.assign(new Error("invalid keyboard session_id"), {
        statusCode: 400,
      });
    }
    const sequence = Number(body.sequence);
    const modifiers = Number(body.modifiers);
    if (!Number.isSafeInteger(sequence) || sequence < 0 ||
        !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 0xff ||
        !Array.isArray(body.keys) || body.keys.length > 6) {
      throw Object.assign(new Error("invalid keyboard report"), {
        statusCode: 400,
      });
    }
    const usages = body.keys.map((usage) => Number(usage));
    if (usages.some((usage) => !Number.isInteger(usage) || !HID_TO_LINUX.has(usage))) {
      throw Object.assign(new Error("unsupported HID usage"), {
        statusCode: 400,
      });
    }
    return { deviceId, sessionId, sequence, modifiers, usages };
  }

  _linuxCodes(modifiers, usages) {
    const codes = [];
    for (const [mask, code] of MODIFIER_TO_LINUX) {
      if ((modifiers & mask) !== 0) codes.push(code);
    }
    for (const usage of usages) {
      const code = HID_TO_LINUX.get(usage);
      if (!codes.includes(code)) codes.push(code);
    }
    return codes;
  }

  async handleReport(device, body) {
    const report = this._validate(device, body);
    const sameSession = this.state?.deviceId === report.deviceId &&
      this.state?.sessionId === report.sessionId;
    if (sameSession && report.sequence <= this.state.lastSequence) {
      return {
        success: true,
        duplicate: true,
        sequence: report.sequence,
      };
    }
    if (this.state && !sameSession) {
      await this.backend.releaseAll();
    }
    const codes = this._linuxCodes(report.modifiers, report.usages);
    await this.backend.report(codes);
    this.state = {
      deviceId: report.deviceId,
      sessionId: report.sessionId,
      lastSequence: report.sequence,
      lastSeen: this.now(),
      codes,
    };
    return {
      success: true,
      duplicate: false,
      sequence: report.sequence,
    };
  }

  async _releaseExpired() {
    if (!this.state?.codes?.length ||
        this.now() - this.state.lastSeen <= REPORT_TIMEOUT_MS) {
      return;
    }
    try {
      await this.backend.releaseAll();
    } catch (error) {
      this.logger?.warn?.("Cardputer keyboard watchdog release failed", {
        error: error?.message || String(error),
      });
    }
    if (this.state) this.state.codes = [];
  }

  stop() {
    clearInterval(this.watchdog);
    Promise.resolve(this.backend.releaseAll()).catch(() => {});
    this.backend.stop?.();
    this.state = null;
  }
}

module.exports = CardputerKeyboardBridge;
module.exports.HID_TO_LINUX = HID_TO_LINUX;
module.exports.MODIFIER_TO_LINUX = MODIFIER_TO_LINUX;
module.exports.LinuxUinputBackend = LinuxUinputBackend;
module.exports.normalizeDeviceId = normalizeDeviceId;
module.exports.parseAllowedDeviceIds = parseAllowedDeviceIds;
