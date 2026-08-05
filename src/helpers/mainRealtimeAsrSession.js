const WebSocket = require("ws");

const REALTIME_ASR_PROTOCOL = "qwen3-asr-v1";
const REALTIME_ASR_AUTH_PREFIX = "auth.";
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_FINAL_TIMEOUT_MS = 5000;
const DEFAULT_PREROLL_MS = 5000;

function protocolsForToken(token) {
  const value = String(token || "").trim();
  return value
    ? [REALTIME_ASR_PROTOCOL, `${REALTIME_ASR_AUTH_PREFIX}${value}`]
    : [];
}

function extractText(payload) {
  return String(
    payload?.final_text ||
    payload?.translated_text ||
    payload?.optimized_text ||
    payload?.asr_text ||
    payload?.text ||
    payload?.partial_text ||
    ""
  ).trim();
}

function usablePayload(payload) {
  return Boolean(
    payload &&
    payload.success !== false &&
    (extractText(payload) || payload.voice_command_applied === true)
  );
}

function timeoutPromise(timeoutMs, message, code) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.code = code;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
}

class MainRealtimeAsrSession {
  constructor({
    connectionProvider,
    logger = null,
    onEvent = null,
    sampleRate = 16000,
    language = "",
    hotword = "",
    optimizeMode = "none",
    translateTarget = "zh",
    intentMode = "none",
    clientIntents = [],
    clientIntentConfidenceThreshold = 0.78,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    finalTimeoutMs = DEFAULT_FINAL_TIMEOUT_MS,
    prerollMs = DEFAULT_PREROLL_MS,
    WebSocketClass = WebSocket,
  } = {}) {
    this.connectionProvider = connectionProvider;
    this.logger = logger;
    this.onEvent = onEvent;
    this.sampleRate = sampleRate;
    this.language = language;
    this.hotword = hotword;
    this.optimizeMode = optimizeMode;
    this.translateTarget = translateTarget;
    this.intentMode = intentMode;
    this.clientIntents = clientIntents;
    this.clientIntentConfidenceThreshold = clientIntentConfidenceThreshold;
    this.connectTimeoutMs = connectTimeoutMs;
    this.finalTimeoutMs = finalTimeoutMs;
    this.maxPendingBytes = Math.max(0, Math.round(sampleRate * 2 * (prerollMs / 1000)));
    this.WebSocketClass = WebSocketClass;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.socket = null;
    this.ready = false;
    this.cancelled = false;
    this.finishing = false;
    this.latestTextPayload = null;
    this.startPromise = null;
    this.finalSettled = false;
    this.finalPromise = new Promise((resolve, reject) => {
      this.resolveFinal = (payload) => {
        if (this.finalSettled) return false;
        this.finalSettled = true;
        resolve(payload);
        return true;
      };
      this.rejectFinal = (error) => {
        if (this.finalSettled) return false;
        this.finalSettled = true;
        reject(error);
        return true;
      };
    });
    this.finalPromise.catch(() => {});
  }

  buildPartialFallback(reason) {
    if (!usablePayload(this.latestTextPayload)) return null;
    return {
      ...this.latestTextPayload,
      partial_fallback: true,
      partial_fallback_reason: String(reason || "final_unavailable"),
    };
  }

  settleFinalFailure(error, reason) {
    if (this.finalSettled) return false;
    const fallback = this.finishing ? this.buildPartialFallback(reason) : null;
    if (fallback) {
      this.logger?.warn?.("Realtime ASR final unavailable; latest partial selected", {
        reason: fallback.partial_fallback_reason,
        textLength: extractText(fallback).length,
        error: error?.message || String(error || ""),
      });
      return this.resolveFinal(fallback);
    }
    return this.rejectFinal(error);
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.open();
    return this.startPromise;
  }

  async open() {
    if (typeof this.connectionProvider !== "function") {
      throw new Error("Realtime ASR connection provider is unavailable");
    }
    const connection = await this.connectionProvider();
    const url = String(connection?.url || "").trim();
    if (!/^wss?:\/\//i.test(url)) {
      throw new Error("Realtime ASR URL is not configured");
    }
    const protocols = protocolsForToken(connection?.token);
    const socket = protocols.length
      ? new this.WebSocketClass(url, protocols)
      : new this.WebSocketClass(url);
    this.socket = socket;

    const opening = new Promise((resolve, reject) => {
      let settled = false;
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.on("open", () => {
        if (this.cancelled) {
          socket.close();
          settleReject(new Error("Realtime ASR session cancelled before open"));
          return;
        }
        socket.send(JSON.stringify({
          type: "start",
          sample_rate: this.sampleRate,
          language: this.language,
          hotword: this.hotword,
          optimize_mode: this.optimizeMode,
          translate_target: this.translateTarget,
          intent_mode: this.intentMode,
          client_intents: this.intentMode === "client_intent" ? this.clientIntents : [],
          client_intent_confidence_threshold: this.clientIntentConfidenceThreshold,
        }));
      });

      socket.on("message", (data) => {
        let payload;
        try {
          payload = JSON.parse(String(data));
        } catch {
          return;
        }
        this.onEvent?.(payload);
        const type = String(payload?.type || "").toLowerCase();
        if (type === "partial" || type === "final") {
          this.latestTextPayload = payload;
        }
        if (type === "ready" && !settled) {
          settled = true;
          this.ready = true;
          this.flushPending();
          resolve(payload);
          return;
        }
        if (type === "final") {
          this.resolveFinal(payload);
          return;
        }
        if (type === "error" || type === "closed") {
          const error = new Error(
            payload?.error ||
            payload?.message ||
            `Realtime ASR returned ${type}`
          );
          error.realtimePayload = payload;
          if (!this.ready) settleReject(error);
          else this.settleFinalFailure(error, `server_${type}`);
        }
      });

      socket.on("error", (error) => {
        if (!this.ready) settleReject(error);
        else this.settleFinalFailure(error, "socket_error");
      });

      socket.on("close", () => {
        if (!this.ready) {
          settleReject(new Error("Realtime ASR websocket closed before ready"));
        } else if (!this.cancelled) {
          this.settleFinalFailure(
            new Error("Realtime ASR websocket closed before final"),
            "socket_closed"
          );
        }
      });
    });

    try {
      return await Promise.race([
        opening,
        timeoutPromise(
          this.connectTimeoutMs,
          `Realtime ASR connect timeout (${this.connectTimeoutMs}ms)`,
          "REALTIME_ASR_CONNECT_TIMEOUT"
        ),
      ]);
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  queuePcm(buffer) {
    if (!buffer.length || this.maxPendingBytes <= 0) return;
    this.pendingChunks.push(buffer);
    this.pendingBytes += buffer.length;
    while (this.pendingBytes > this.maxPendingBytes && this.pendingChunks.length) {
      const dropped = this.pendingChunks.shift();
      this.pendingBytes -= dropped.length;
    }
  }

  sendPcm(value) {
    if (this.cancelled || this.finishing) return false;
    const buffer = Buffer.from(value || []);
    if (!buffer.length) return false;
    if (this.ready && this.socket?.readyState === this.WebSocketClass.OPEN) {
      this.socket.send(buffer);
      return true;
    }
    this.queuePcm(buffer);
    return false;
  }

  flushPending() {
    if (!this.ready || this.socket?.readyState !== this.WebSocketClass.OPEN) return;
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    for (const chunk of chunks) {
      this.socket.send(chunk);
    }
  }

  async finish() {
    if (this.cancelled) throw new Error("Realtime ASR session is cancelled");
    const finishStartedAt = Date.now();
    this.finishing = true;
    await this.start();
    this.flushPending();
    if (!this.socket || this.socket.readyState !== this.WebSocketClass.OPEN) {
      throw new Error("Realtime ASR session is not open");
    }
    this.socket.send(JSON.stringify({ type: "finish" }));
    try {
      const payload = await Promise.race([
        this.finalPromise,
        timeoutPromise(
          this.finalTimeoutMs,
          `Realtime ASR final timeout (${this.finalTimeoutMs}ms)`,
          "REALTIME_ASR_FINAL_TIMEOUT"
        ),
      ]);
      this.socket.close();
      this.logger?.info?.("Realtime ASR final settled", {
        elapsedMs: Date.now() - finishStartedAt,
        partialFallback: payload?.partial_fallback === true,
        fallbackReason: payload?.partial_fallback_reason || "",
        textLength: extractText(payload).length,
      });
      return payload;
    } catch (error) {
      if (error.code === "REALTIME_ASR_FINAL_TIMEOUT") {
        const fallback = this.buildPartialFallback("final_timeout");
        if (!fallback) {
          this.cancel();
          throw error;
        }
        this.resolveFinal(fallback);
        this.socket.close();
        this.logger?.warn?.("Realtime ASR final timed out; latest partial selected", {
          elapsedMs: Date.now() - finishStartedAt,
          timeoutMs: this.finalTimeoutMs,
          textLength: extractText(fallback).length,
        });
        return fallback;
      }
      this.cancel();
      throw error;
    }
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === this.WebSocketClass.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "cancel" }));
      } catch {
        // The socket is already closing.
      }
    }
    if (
      socket.readyState === this.WebSocketClass.OPEN ||
      socket.readyState === this.WebSocketClass.CONNECTING
    ) {
      socket.close();
    }
  }
}

module.exports = {
  MainRealtimeAsrSession,
  extractText,
  usablePayload,
};
