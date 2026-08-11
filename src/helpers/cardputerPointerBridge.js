const path = require("node:path");
const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = 1;
const REPORT_TIMEOUT_MS = 750;
const DEFAULT_ALLOWED_DEVICE_IDS = "28:84:85:76:25:c0";

function normalizeDeviceId(value) {
  return String(value || "").trim().toLowerCase();
}

function parseAllowedDeviceIds(value = DEFAULT_ALLOWED_DEVICE_IDS) {
  return new Set(String(value || "")
    .split(",")
    .map(normalizeDeviceId)
    .filter(Boolean));
}

function configuredDeviceIds(explicitValue) {
  if (explicitValue !== undefined) return explicitValue;
  if (process.env.M5_CARDPUTER_INPUT_DEVICE_IDS !== undefined) {
    return process.env.M5_CARDPUTER_INPUT_DEVICE_IDS;
  }
  return process.env.M5_CARDPUTER_KEYBOARD_DEVICE_IDS;
}

function helperPath() {
  if (__dirname.includes("app.asar")) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "src",
      "helpers",
      "cardputer_pointer_uinput.py"
    );
  }
  return path.join(__dirname, "cardputer_pointer_uinput.py");
}

class LinuxUinputPointerBackend {
  constructor({ logger = null, spawnProcess = spawn } = {}) {
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.readyPromise = null;
    this.stopping = false;
  }

  async _ensureStarted() {
    if (process.platform !== "linux") {
      throw Object.assign(new Error("Cardputer pointer injection requires Linux"), {
        statusCode: 501,
      });
    }
    if (this.readyPromise) return this.readyPromise;

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
        finish(Object.assign(new Error("uinput pointer helper startup timed out"), {
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
          new Error(stderr.trim() || `uinput pointer helper exited with code ${code}`),
          { statusCode: 503 }
        );
        finish(error);
        this.child = null;
        this.readyPromise = null;
        if (!this.stopping) {
          this.logger?.warn?.("Cardputer pointer uinput helper exited", {
            code,
            error: error.message,
          });
        }
      });
    });
    return this.readyPromise;
  }

  async report(report) {
    await this._ensureStarted();
    if (!this.child?.stdin?.writable) {
      throw Object.assign(new Error("uinput pointer helper is unavailable"), {
        statusCode: 503,
      });
    }
    this.child.stdin.write(`${JSON.stringify({ type: "report", ...report })}\n`);
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

class CardputerPointerBridge {
  constructor({ logger = null, backend = null, allowedDeviceIds, now = Date.now, mapper = null } = {}) {
    this.logger = logger;
    this.backend = backend || new LinuxUinputPointerBackend({ logger });
    const configured = configuredDeviceIds(allowedDeviceIds);
    this.allowedDeviceIds = parseAllowedDeviceIds(
      configured === undefined ? DEFAULT_ALLOWED_DEVICE_IDS : configured
    );
    this.now = now;
    this.mapper = mapper;
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
      throw Object.assign(new Error("Cardputer pointer device is not allowed"), {
        statusCode: 403,
      });
    }
    if (body?.protocol_version !== PROTOCOL_VERSION) {
      throw Object.assign(new Error("unsupported pointer protocol"), {
        statusCode: 400,
      });
    }
    const sessionId = String(body.session_id || "").trim();
    const sequence = Number(body.sequence);
    const dx = Number(body.dx);
    const dy = Number(body.dy);
    const wheel = Number(body.wheel);
    const buttons = Number(body.buttons);
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(sessionId) ||
        !Number.isSafeInteger(sequence) || sequence < 0 ||
        !Number.isInteger(dx) || dx < -2048 || dx > 2048 ||
        !Number.isInteger(dy) || dy < -2048 || dy > 2048 ||
        !Number.isInteger(wheel) || wheel < -32 || wheel > 32 ||
        !Number.isInteger(buttons) || buttons < 0 || buttons > 3) {
      throw Object.assign(new Error("invalid pointer report"), {
        statusCode: 400,
      });
    }
    return { deviceId, sessionId, sequence, dx, dy, wheel, buttons };
  }

  async handleReport(device, body) {
    const report = this._validate(device, body);
    const sameSession = this.state?.deviceId === report.deviceId &&
      this.state?.sessionId === report.sessionId;
    if (sameSession && report.sequence <= this.state.lastSequence) {
      return { success: true, duplicate: true, sequence: report.sequence };
    }
    if (this.state && !sameSession) await this.backend.releaseAll();

    const output = this.mapper
      ? await this.mapper.transformPointerReport(
        report.deviceId,
        report,
        sameSession ? this.state?.buttons || 0 : 0
      )
      : report;
    await this.backend.report({
      dx: output.dx,
      dy: output.dy,
      wheel: output.wheel,
      buttons: output.buttons,
    });
    this.state = {
      deviceId: report.deviceId,
      sessionId: report.sessionId,
      lastSequence: report.sequence,
      lastSeen: this.now(),
      buttons: report.buttons,
      outputButtons: output.buttons,
    };
    return { success: true, duplicate: false, sequence: report.sequence };
  }

  async _releaseExpired() {
    if (!this.state?.buttons ||
        this.now() - this.state.lastSeen <= REPORT_TIMEOUT_MS) {
      return;
    }
    try {
      await this.backend.releaseAll();
    } catch (error) {
      this.logger?.warn?.("Cardputer pointer watchdog release failed", {
        error: error?.message || String(error),
      });
    }
    if (this.state) this.state.buttons = 0;
  }

  stop() {
    clearInterval(this.watchdog);
    Promise.resolve(this.backend.releaseAll()).catch(() => {});
    this.backend.stop?.();
    this.state = null;
  }
}

module.exports = CardputerPointerBridge;
module.exports.LinuxUinputPointerBackend = LinuxUinputPointerBackend;
module.exports.normalizeDeviceId = normalizeDeviceId;
module.exports.parseAllowedDeviceIds = parseAllowedDeviceIds;
