const RUNTIME_ENV_BY_SETTING = {
  backend_url: ["CAPSWRITER_BACKEND_URL", "VITE_BACKEND_URL"],
  tts_base_url: ["CAPSWRITER_TTS_BASE_URL", "VITE_TTS_BASE_URL"],
  server_llm_url: ["QWEN_ROUTER_SERVER_LLM_URL", "CAPSWRITER_SERVER_LLM_URL"],
  realtime_asr_url: ["CAPSWRITER_REALTIME_ASR_URL", "VITE_REALTIME_ASR_URL"],
  realtime_asr_token: ["CAPSWRITER_REALTIME_ASR_TOKEN"],
  realtime_asr_fallback_url: ["CAPSWRITER_REALTIME_ASR_FALLBACK_URL"],
};
const RUNTIME_ONLY_SETTINGS = new Set(["realtime_asr_token"]);

function getRuntimeSettingDefault(key, defaultValue, env = process.env) {
  const names = RUNTIME_ENV_BY_SETTING[key] || [];
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return defaultValue;
}

function readSetting(databaseManager, key, defaultValue, env = process.env) {
  const runtimeDefault = getRuntimeSettingDefault(key, defaultValue, env);
  if (RUNTIME_ONLY_SETTINGS.has(key)) return runtimeDefault;
  return databaseManager.getSetting(key, runtimeDefault);
}

function assertSettingWritable(key) {
  if (RUNTIME_ONLY_SETTINGS.has(key)) {
    throw new Error(`${key} is a runtime-only setting`);
  }
}

function sanitizeStoredSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  const sanitized = { ...settings };
  for (const key of RUNTIME_ONLY_SETTINGS) delete sanitized[key];
  return sanitized;
}

module.exports = {
  RUNTIME_ENV_BY_SETTING,
  RUNTIME_ONLY_SETTINGS,
  assertSettingWritable,
  getRuntimeSettingDefault,
  readSetting,
  sanitizeStoredSettings,
};
