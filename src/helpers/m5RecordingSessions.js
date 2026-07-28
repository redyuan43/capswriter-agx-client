const fs = require("fs");
const os = require("os");
const path = require("path");

class M5RecordingSessions {
  constructor({
    now = Date.now,
    cleanupMs = 60000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "capswriter-recordings-")),
  } = {}) {
    this.now = now;
    this.cleanupMs = cleanupMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.spoolDir = spoolDir;
    this.sessions = new Map();
  }

  create({ id, intent, mode, targetWindowId = "", ownerDeviceId = "", triggerId = "" }) {
    const existing = this.sessions.get(id);
    if (existing && !existing.done) {
      return existing;
    }
    const safeId = String(id || "session").replace(/[^a-zA-Z0-9_-]/g, "_");
    const pcmFile = path.join(this.spoolDir, `${safeId}.pcm`);
    fs.mkdirSync(this.spoolDir, { recursive: true });
    fs.writeFileSync(pcmFile, Buffer.alloc(0));
    const session = {
      id,
      status: "recording",
      intent,
      mode,
      bytes: 0,
      chunks: 0,
      pcmFile,
      sampleRate: 16000,
      audioFile: "",
      done: false,
      createdAt: this.now(),
      targetWindowId,
      ownerDeviceId,
      triggerId,
      expectedChunkId: 0,
      receivedChunkIds: new Map(),
      firstAudioAt: 0,
      lastAudioAt: 0,
      lastUploadAttemptAt: 0,
      rendererDispatched: false,
      rendererStopped: false,
      terminationStarted: false,
      pendingEnter: false,
      enterSent: false,
      enterDispatching: false,
      cancelRequested: false,
      result: null,
      resolver: null,
      stopTimer: null,
      cleanupTimer: null,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  appendAudio(session, chunk) {
    if (!session || session.done || !chunk || chunk.length === 0) {
      return false;
    }
    const audio = Buffer.from(chunk);
    session.bytes += audio.length;
    session.chunks += 1;
    session.lastAudioAt = this.now();
    fs.appendFileSync(session.pcmFile, audio);
    return true;
  }

  currentState() {
    const active = [...this.sessions.values()].find((session) => !session.done);
    if (!active) {
      return { status: "idle", session_id: "" };
    }
    return {
      status: active.status,
      session_id: active.id,
      source: "m5stickc_plus",
      intent: active.intent || "dictation",
    };
  }

  latestId() {
    const active = [...this.sessions.values()].filter((session) => !session.done);
    active.sort((a, b) => b.createdAt - a.createdAt);
    return active[0]?.id || "";
  }

  queueEnter(sessionId) {
    const session = this.get(sessionId);
    if (!session) {
      return { status: "session_not_found" };
    }
    if (session.done) {
      return { status: "session_completed", session };
    }
    session.pendingEnter = true;
    return { status: "queued", session };
  }

  requestCancel(sessionId) {
    const session = this.get(sessionId);
    if (!session) {
      return { status: "session_not_found" };
    }
    if (session.done) {
      return { status: "session_completed", session };
    }
    session.cancelRequested = true;
    session.pendingEnter = false;
    return { status: "cancelled", session };
  }

  claimEnterDispatch(session, result = {}) {
    if (!session) {
      return { status: "session_not_found" };
    }
    if (session.enterSent) {
      return { status: "already_sent" };
    }
    if (session.enterDispatching) {
      return { status: "dispatching" };
    }
    const status = String(result.status || session.status || "").trim();
    if (result.success === false || status !== "pasted") {
      return { status: "paste_not_successful" };
    }
    if (!session.targetWindowId) {
      return { status: "no_target_window" };
    }
    session.enterDispatching = true;
    return {
      status: "claimed",
      sessionId: session.id,
      targetWindowId: String(session.targetWindowId),
    };
  }

  settleEnterDispatch(session, { sent = false } = {}) {
    if (!session) {
      return;
    }
    if (sent) {
      session.enterSent = true;
    }
    session.enterDispatching = false;
  }

  waitForResult(session, timeoutMs, onTimeout) {
    if (!session || session.done) {
      return Promise.resolve(session?.result || {});
    }
    return new Promise((resolve) => {
      session.resolver = resolve;
      session.stopTimer = this.setTimer(() => {
        onTimeout?.();
      }, timeoutMs);
    });
  }

  finish(session, result) {
    if (!session || session.done) {
      return { finished: false, pendingEnter: false };
    }
    session.result = result || {};
    session.done = true;
    session.status = session.result.status ||
      (session.result.success === false ? "transcription_failed" : "pasted");
    if (session.stopTimer) {
      this.clearTimer(session.stopTimer);
      session.stopTimer = null;
    }
    if (session.resolver) {
      session.resolver(session.result);
      session.resolver = null;
    }
    session.cleanupTimer = this.setTimer(() => {
      this.sessions.delete(session.id);
      try {
        fs.rmSync(session.pcmFile, { force: true });
      } catch (_) {
        // Best-effort cleanup only.
      }
      session.cleanupTimer = null;
    }, this.cleanupMs);
    session.cleanupTimer.unref?.();
    return { finished: true, pendingEnter: session.pendingEnter };
  }

  clear() {
    for (const session of this.sessions.values()) {
      if (session.stopTimer) {
        this.clearTimer(session.stopTimer);
      }
      if (session.cleanupTimer) {
        this.clearTimer(session.cleanupTimer);
      }
    }
    this.sessions.clear();
    try {
      fs.rmSync(this.spoolDir, { recursive: true, force: true });
    } catch (_) {
      // Best-effort cleanup only.
    }
  }
}

module.exports = M5RecordingSessions;
