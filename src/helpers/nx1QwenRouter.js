const DEFAULT_MODEL = "caps-voice-edit-qwen3-4b";
const DEFAULT_MODEL_LABEL = "Qwen3:4b";
const DEFAULT_SERVER_LLM_PATH = "/api/llm/chat";
const DEFAULT_SERVER_LLM_URL = "ws://spark-31d6.taild500c8.ts.net:18011/api/llm/chat";
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_CACHE_TTL_MS = 60000;
const DEFAULT_ROUTE_CONFIDENCE_THRESHOLD = 0.72;

function normalizeWsUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function deriveServerLlmUrl() {
  const explicit = normalizeWsUrl(
    process.env.QWEN_ROUTER_SERVER_LLM_URL ||
    process.env.CAPSWRITER_SERVER_LLM_URL ||
    process.env.SERVER_LLM_URL
  );
  if (explicit) return explicit;

  const realtimeUrl = normalizeWsUrl(
    process.env.VITE_REALTIME_ASR_URL ||
    process.env.SPARK_REALTIME_ASR_URL ||
    ""
  );
  if (realtimeUrl) {
    if (/\/api\/asr\/realtime$/i.test(realtimeUrl)) {
      return realtimeUrl.replace(/\/api\/asr\/realtime$/i, DEFAULT_SERVER_LLM_PATH);
    }
    return `${realtimeUrl.replace(/\/+$/g, "")}${DEFAULT_SERVER_LLM_PATH}`;
  }

  return DEFAULT_SERVER_LLM_URL;
}

function normalizeServerEvent(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw || ""));
  } catch (_) {
    return null;
  }
}

function serverChatCompletion(url, requestBody, timeoutMs) {
  return new Promise((resolve) => {
    if (typeof WebSocket === "undefined") {
      resolve({ success: false, error: "当前 Electron 主进程不支持 WebSocket" });
      return;
    }

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          socket.close();
        }
      } catch (_) {
        // best effort cleanup
      }
      resolve(result);
    };

    let socket = null;
    const timer = setTimeout(() => {
      settle({ success: false, error: "请求超时" });
    }, timeoutMs);

    try {
      socket = new WebSocket(url);
    } catch (error) {
      settle({ success: false, error: error?.message || String(error) });
      return;
    }

    socket.onopen = () => {
      socket.send(JSON.stringify(requestBody));
    };

    socket.onmessage = (event) => {
      const payload = normalizeServerEvent(event.data);
      if (!payload) {
        settle({ success: false, error: "服务端返回了无效 JSON" });
        return;
      }
      if (payload.success === false || payload.type === "error") {
        settle({
          success: false,
          error: payload.error || payload.message || "服务端小模型请求失败",
          endpoint: { baseUrl: url, name: "spark-server" },
          data: payload
        });
        return;
      }
      if (payload.type === "chat_completion" || payload.data || payload.text !== undefined) {
        settle({
          success: true,
          data: payload.data || payload,
          text: payload.text || payload.data?.choices?.[0]?.message?.content || "",
          usage: payload.usage || payload.data?.usage,
          model: payload.model || requestBody.model,
          endpoint: { baseUrl: url, name: "spark-server", model: payload.model || requestBody.model }
        });
      }
    };

    socket.onerror = () => {
      settle({ success: false, error: "服务端小模型 WebSocket 连接失败" });
    };

    socket.onclose = (event) => {
      if (!settled) {
        settle({
          success: false,
          error: event?.reason || `服务端小模型连接已关闭 (${event?.code || "unknown"})`
        });
      }
    };
  });
}

class Nx1QwenRouter {
  constructor({ databaseManager = null, logger = null } = {}) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    this.cachedEndpoint = null;
    this.cachedAt = 0;
  }

  async getConfig() {
    const getSetting = async (key, fallback) => {
      if (!this.databaseManager?.getSetting) return fallback;
      return await this.databaseManager.getSetting(key, fallback);
    };

    const model = await getSetting(
      "server_llm_model",
      process.env.SERVER_LLM_MODEL ||
      process.env.VOICE_EDIT_LLM_MODEL ||
      DEFAULT_MODEL
    );
    const serverUrl = await getSetting(
      "server_llm_url",
      process.env.QWEN_ROUTER_SERVER_LLM_URL ||
      process.env.CAPSWRITER_SERVER_LLM_URL ||
      deriveServerLlmUrl()
    );
    const requestTimeoutMs = await getSetting(
      "server_llm_request_timeout_ms",
      process.env.SERVER_LLM_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS
    );
    const cacheTtlMs = await getSetting(
      "server_llm_cache_ttl_ms",
      process.env.SERVER_LLM_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS
    );
    const confidenceThreshold = await getSetting(
      "qwen_router_confidence_threshold",
      process.env.QWEN_ROUTER_CONFIDENCE_THRESHOLD || DEFAULT_ROUTE_CONFIDENCE_THRESHOLD
    );

    return {
      model: String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      endpoint: {
        name: "spark-server",
        baseUrl: normalizeWsUrl(serverUrl) || deriveServerLlmUrl()
      },
      requestTimeoutMs: normalizePositiveNumber(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      cacheTtlMs: normalizePositiveNumber(cacheTtlMs, DEFAULT_CACHE_TTL_MS),
      confidenceThreshold: normalizePositiveNumber(confidenceThreshold, DEFAULT_ROUTE_CONFIDENCE_THRESHOLD)
    };
  }

  clearCache() {
    this.cachedEndpoint = null;
    this.cachedAt = 0;
  }

  async resolveEndpoint({ force = false } = {}) {
    const config = await this.getConfig();
    const now = Date.now();
    if (
      !force &&
      this.cachedEndpoint &&
      now - this.cachedAt < config.cacheTtlMs &&
      this.cachedEndpoint.baseUrl === config.endpoint.baseUrl
    ) {
      return { success: true, endpoint: this.cachedEndpoint, cached: true, model: config.model };
    }

    this.cachedEndpoint = {
      ...config.endpoint,
      model: config.model,
      checkedAt: Date.now()
    };
    this.cachedAt = Date.now();
    return {
      success: true,
      endpoint: this.cachedEndpoint,
      cached: false,
      model: config.model,
      attempts: []
    };
  }

  async chatCompletion(messages, options = {}) {
    const config = await this.getConfig();
    const resolved = await this.resolveEndpoint();
    if (!resolved.success) return resolved;

    const requestBody = {
      type: "chat",
      model: options.model || config.model,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens || options.maxTokens || 512,
      timeout_ms: options.timeoutMs || options.timeout_ms || config.requestTimeoutMs,
      stream: false
    };
    if (options.response_format) requestBody.response_format = options.response_format;

    const requestTimeoutMs = normalizePositiveNumber(
      options.timeoutMs || options.timeout_ms,
      config.requestTimeoutMs
    );
    const result = await serverChatCompletion(
      resolved.endpoint.baseUrl,
      requestBody,
      requestTimeoutMs
    );
    if (result.success) {
      return {
        ...result,
        endpoint: resolved.endpoint
      };
    }
    this.clearCache();
    return {
      ...result,
      endpoint: resolved.endpoint
    };
  }

  async routeTerminalRequest({ request, activeWindow = null, candidates = [] } = {}) {
    const config = await this.getConfig();
    const messages = [
      {
        role: "system",
        content:
          "你是 CapsWriter 的本地终端调度器。只输出 JSON，不要解释。action 只能是 route、ask、new_session；" +
          "不确定时必须选择 ask。confidence 取 0 到 1。"
      },
      {
        role: "user",
        content: JSON.stringify({
          user_request: String(request || "").trim(),
          active_window: activeWindow,
          terminal_candidates: candidates,
          output_schema: {
            action: "route|ask|new_session",
            target_terminal_id: "string|null",
            confidence: "number",
            question: "string|null",
            reason: "string"
          },
          confidence_threshold: config.confidenceThreshold
        })
      }
    ];

    const response = await this.chatCompletion(messages, {
      temperature: 0,
      max_tokens: 256,
      response_format: { type: "json_object" }
    });
    if (!response.success) return response;

    try {
      const decision = JSON.parse(response.text);
      if (Number(decision.confidence) < config.confidenceThreshold && decision.action === "route") {
        decision.action = "ask";
        decision.target_terminal_id = null;
        decision.question = decision.question || "你想把这条指令发到哪个终端？";
      }
      return {
        success: true,
        decision,
        endpoint: response.endpoint,
        usage: response.usage
      };
    } catch (error) {
      return {
        success: false,
        error: `调度结果不是有效 JSON：${error?.message || error}`,
        raw: response.text,
        endpoint: response.endpoint
      };
    }
  }
}

module.exports = {
  Nx1QwenRouter,
  DEFAULT_MODEL,
  DEFAULT_MODEL_LABEL,
  DEFAULT_SERVER_LLM_URL,
  DEFAULT_SERVER_LLM_PATH
};
