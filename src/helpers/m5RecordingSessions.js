class M5RecordingSessions {
  constructor({
    now = Date.now,
    cleanupMs = 60000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.now = now;
    this.cleanupMs = cleanupMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sessions = new Map();
  }

  create({ id, intent, mode, targetWindowId = "" }) {
    const session = {
      id,
      status: "recording",
      intent,
      mode,
      bytes: 0,
      chunks: 0,
      audioChunks: [],
      sampleRate: 16000,
      audioFile: "",
      done: false,
      createdAt: this.now(),
      targetWindowId,
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
    session.audioChunks.push(audio);
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

  waitForResult(session, timeoutMs, onTimeout) {
    if (!session || session.done) {
      return Promise.resolve(session?.result || {});
    }
    return new Promise((resolve) => {
      session.resolver = resolve;
      session.stopTimer = this.setTimer(() => {
        onTimeout?.();
      }, timeoutMs);
      session.stopTimer.unref?.();
    });
  }

  finish(session, result) {
    if (!session || session.done) {
      return false;
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
      session.cleanupTimer = null;
    }, this.cleanupMs);
    session.cleanupTimer.unref?.();
    return true;
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
  }
}

module.exports = M5RecordingSessions;
