const ENTER_FOLLOWUP = Object.freeze({
  name: "enter",
  keyName: "Return",
});

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class M5FollowupKeyDispatcher {
  constructor({
    logger,
    platform = process.platform,
    runCommand,
    sleep = defaultSleep,
    schedule = setImmediate,
    settleMs = 120,
  }) {
    this.logger = logger;
    this.platform = platform;
    this.runCommand = runCommand;
    this.sleep = sleep;
    this.schedule = schedule;
    this.settleMs = settleMs;
  }

  async send({
    sessionId,
    targetWindowId,
    keyName,
    reason = "queued",
  }) {
    if (!targetWindowId) {
      this.logger?.warn?.("M5 follow-up key skipped: no target window", {
        sessionId,
        reason,
      });
      return { success: false, status: "no_target_window", reason };
    }
    if (this.platform !== "linux") {
      this.logger?.warn?.("M5 follow-up key unsupported on this platform", {
        sessionId,
        platform: this.platform,
        reason,
      });
      return { success: false, status: "unsupported_platform", reason };
    }

    const windowId = String(targetWindowId);
    const activate = await this.runCommand(
      "xdotool",
      ["windowactivate", "--sync", windowId],
      2000
    );
    if (!activate.success) {
      this.logger?.warn?.("M5 follow-up key failed to activate target window", {
        sessionId,
        targetWindowId: windowId,
        error: activate.error || activate.stderr,
        reason,
      });
      return { success: false, status: "activate_failed", reason };
    }

    await this.sleep(this.settleMs);
    const key = await this.runCommand(
      "xdotool",
      ["key", "--delay", "35", keyName],
      1500
    );
    if (!key.success) {
      this.logger?.warn?.(`M5 follow-up key failed to send ${keyName}`, {
        sessionId,
        targetWindowId: windowId,
        error: key.error || key.stderr,
        reason,
      });
      return { success: false, status: "send_failed", reason };
    }

    this.logger?.info?.("M5 follow-up key sent", {
      sessionId,
      targetWindowId: windowId,
      keyName,
      reason,
    });
    return { success: true, status: "sent", reason };
  }

  enqueue(payload, onComplete) {
    return new Promise((resolve) => {
      this.schedule(() => {
        this.send(payload).catch((error) => {
          this.logger?.warn?.("M5 follow-up key failed", {
            sessionId: payload.sessionId,
            error: error?.message || String(error),
          });
          return { success: false, status: "dispatch_failed", reason: payload.reason };
        }).then((result) => {
          onComplete?.(result);
          resolve(result);
        });
      });
    });
  }
}

module.exports = M5FollowupKeyDispatcher;
module.exports.ENTER_FOLLOWUP = ENTER_FOLLOWUP;
