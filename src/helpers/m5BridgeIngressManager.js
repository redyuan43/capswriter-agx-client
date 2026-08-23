const path = require("path");
const { fork } = require("child_process");

class M5BridgeIngressManager {
  constructor({
    logger = null,
    host = "0.0.0.0",
    port = 8765,
    internalPort = 8766,
    onAudio = () => {},
  } = {}) {
    this.logger = logger;
    this.host = host;
    this.port = port;
    this.internalPort = internalPort;
    this.onAudio = onAudio;
    this.child = null;
  }

  start() {
    if (this.child) {
      return;
    }
    const entry = path.join(__dirname, "m5BridgeIngressProcess.js");
    this.child = fork(entry, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        M5_BRIDGE_INGRESS_HOST: this.host,
        M5_BRIDGE_INGRESS_PORT: String(this.port),
        M5_BRIDGE_INGRESS_INTERNAL_PORT: String(this.internalPort),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      // PCM packets must cross this boundary as buffers. The default JSON
      // serialization expands every byte into a number and lets the IPC
      // queue fall behind during realtime recording.
      serialization: "advanced",
    });
    this.child.on("message", (message) => {
      if (message?.type === "recording-audio") {
        const result = this.onAudio(message.payload || {});
        if (result?.accepted === false) {
          this.logger?.warn?.("M5 ingress audio delivery rejected", result);
        }
        return;
      }
      if (message?.type === "log") {
        const write = this.logger?.[message.level] || this.logger?.info;
        write?.call(this.logger, message.message, message.data);
      }
    });
    this.child.on("exit", (code, signal) => {
      if (this.child) {
        this.logger?.warn?.("M5 ingress process exited", { code, signal });
      }
      this.child = null;
    });
  }

  stop() {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    child.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
  }
}

module.exports = M5BridgeIngressManager;
