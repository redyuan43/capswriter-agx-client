const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ENABLED_SETTING = "knob_mapper_enabled";
const RESTART_DELAY_MS = 2000;
const MAX_LOG_LINES = 80;

const VERIFIED_MAPPINGS = [
  {
    id: "liqi",
    name: "LiQi 双旋钮",
    device: "LiQi Technology USB Composite Device",
    entries: [
      ["旋钮 1 顺时针", "KEY_VOLUMEUP", "Alt_L + Super_L + Right"],
      ["旋钮 1 逆时针", "KEY_VOLUMEDOWN", "Alt_L + Super_L + Left"],
      ["旋钮 1 按住顺时针", "KEY_NEXTSONG", "Shift_L + Super_L + Right"],
      ["旋钮 1 按住逆时针", "KEY_PREVIOUSSONG", "Shift_L + Super_L + Left"],
      ["旋钮 2 顺时针", "KEY_2", "Control_L + Super_L + Right"],
      ["旋钮 2 逆时针", "KEY_1", "Control_L + Super_L + Left"],
      ["主按钮释放脉冲", "KEY_MUTE", "Return"],
    ],
  },
  {
    id: "doio",
    name: "DOIO 三键键盘",
    device: "DOIO KBGM-M03A-HE",
    entries: [
      ["第一键", "KEY_J", "按住 Super_L"],
      ["中间键", "KEY_K", "按住 Return"],
      ["最后一键", "KEY_L", "按住 Right Shift"],
      ["上方向键", "KEY_UP", "滚动向上"],
      ["下方向键", "KEY_DOWN", "滚动向下"],
      ["左方向键", "KEY_LEFT", "窗口向前切换"],
      ["右方向键", "KEY_RIGHT", "窗口向后切换"],
      ["回车键", "KEY_ENTER", "Return"],
    ],
  },
  {
    id: "iine",
    name: "IINE 单键设备",
    device: "IINE_keyboard",
    entries: [["按键", "KEY_SPACE", "按住 Right Shift"]],
  },
  {
    id: "ulanzi",
    name: "Ulanzi / MINI_KEYBOARD",
    device: "Ulanzi Dial Keyboard, MINI_KEYBOARD",
    entries: [
      ["旋钮 1 顺时针", "KEY_VOLUMEUP", "Alt_L + Super_L + Right"],
      ["旋钮 1 逆时针", "KEY_VOLUMEDOWN", "Alt_L + Super_L + Left"],
      ["按住旋钮 1 顺时针", "KEY_NEXTSONG", "Shift_L + Super_L + Right"],
      ["按住旋钮 1 逆时针", "KEY_PREVIOUSSONG", "Shift_L + Super_L + Left"],
      ["触摸/轴事件", "ABS_Y", "旋钮 2 方向动作"],
    ],
  },
];

function appendLines(target, chunk) {
  const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
  target.push(...lines);
  if (target.length > MAX_LOG_LINES) {
    target.splice(0, target.length - MAX_LOG_LINES);
  }
}

class KnobMapperManager {
  constructor({ logger, databaseManager, dataDirectory }) {
    this.logger = logger;
    this.databaseManager = databaseManager;
    this.dataDirectory = dataDirectory;
    this.child = null;
    this.restartTimer = null;
    this.intentionalStop = false;
    this.startedAt = null;
    this.lastError = "";
    this.logs = [];
  }

  isSupported() {
    return process.platform === "linux";
  }

  isEnabled() {
    return this.databaseManager.getSetting(ENABLED_SETTING, true) !== false;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    this.databaseManager.setSetting(ENABLED_SETTING, next);
    return next ? this.start({ automatic: false }) : this.stop();
  }

  getSourceDirectory() {
    if (process.env.NODE_ENV === "development" || !process.resourcesPath) {
      return path.resolve(__dirname, "../../python/knob-mapper");
    }
    return path.join(process.resourcesPath, "app.asar.unpacked", "python", "knob-mapper");
  }

  getRuntimeDirectory() {
    return path.join(this.dataDirectory, "knob-mapper");
  }

  getRuntimeConfigPath() {
    return path.join(this.getRuntimeDirectory(), "config.yaml");
  }

  ensureRuntimeConfig() {
    const sourceConfig = path.join(this.getSourceDirectory(), "config.yaml");
    const runtimeDirectory = this.getRuntimeDirectory();
    const runtimeConfig = this.getRuntimeConfigPath();
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    if (!fs.existsSync(runtimeConfig)) {
      fs.copyFileSync(sourceConfig, runtimeConfig);
    }
    return runtimeConfig;
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  start({ automatic = false } = {}) {
    if (!this.isSupported()) {
      return Promise.resolve({ success: false, supported: false, error: "设备映射仅支持 Linux" });
    }
    if (this.isRunning()) {
      return Promise.resolve(this.getStatus());
    }

    this.intentionalStop = false;
    this.lastError = "";
    let configPath;
    try {
      configPath = this.ensureRuntimeConfig();
    } catch (error) {
      this.lastError = error?.message || String(error);
      return Promise.resolve({ success: false, error: this.lastError });
    }

    const scriptPath = path.join(this.getSourceDirectory(), "knob_mapper.py");
    const python = process.env.CAPSWRITER_PYTHON || "python3";
    this.appendLog(`Starting knob mapper: ${python} ${scriptPath}`);

    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(python, [scriptPath, "--config", configPath], {
        cwd: this.getSourceDirectory(),
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.startedAt = new Date().toISOString();

      child.stdout.on("data", (chunk) => this.appendLog(chunk));
      child.stderr.on("data", (chunk) => {
        this.appendLog(chunk);
        this.lastError = String(chunk).trim() || this.lastError;
      });
      child.once("error", (error) => {
        this.lastError = error?.message || String(error);
        this.appendLog(`Process error: ${this.lastError}`);
        if (!settled) {
          settled = true;
          resolve({ success: false, error: this.lastError });
        }
      });
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve(this.getStatus());
        }
      });
      child.once("close", (code, signal) => {
        this.appendLog(`Knob mapper exited: code=${code} signal=${signal || "none"}`);
        if (this.child === child) this.child = null;
        if (!this.intentionalStop && this.isEnabled()) {
          this.scheduleRestart();
        }
      });

      if (automatic) {
        this.appendLog("Knob mapper automatic startup requested");
      }
    });
  }

  scheduleRestart() {
    if (this.restartTimer || this.intentionalStop) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start({ automatic: true }).catch((error) => {
        this.logger.warn("Knob mapper restart failed", error?.message || error);
      });
    }, RESTART_DELAY_MS);
  }

  stop() {
    this.intentionalStop = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return Promise.resolve({ success: true, running: false });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve({ success: true, running: false });
      }, 1500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve({ success: true, running: false });
      });
      child.kill("SIGTERM");
    });
  }

  restart() {
    return this.stop().then(() => this.start({ automatic: false }));
  }

  listDevices() {
    if (!this.isSupported()) {
      return Promise.resolve({ success: false, supported: false, error: "设备映射仅支持 Linux" });
    }
    let configPath;
    try {
      configPath = this.ensureRuntimeConfig();
    } catch (error) {
      return Promise.resolve({ success: false, error: error?.message || String(error) });
    }
    const python = process.env.CAPSWRITER_PYTHON || "python3";
    const scriptPath = path.join(this.getSourceDirectory(), "knob_mapper.py");
    return new Promise((resolve) => {
      const child = spawn(python, [scriptPath, "--config", configPath, "--list-devices"], {
        cwd: this.getSourceDirectory(),
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
      child.once("error", (error) => resolve({ success: false, error: error?.message || String(error) }));
      child.once("close", (code) => resolve({
        success: code === 0,
        code,
        output: stdout.join(""),
        error: stderr.join("").trim(),
      }));
    });
  }

  appendLog(chunk) {
    appendLines(this.logs, chunk);
    if (this.logger && chunk) this.logger.info(String(chunk).trim());
  }

  getStatus() {
    return {
      success: true,
      supported: this.isSupported(),
      enabled: this.isEnabled(),
      running: this.isRunning(),
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      logs: [...this.logs],
      mappings: VERIFIED_MAPPINGS,
    };
  }
}

module.exports = {
  ENABLED_SETTING,
  VERIFIED_MAPPINGS,
  KnobMapperManager,
};
