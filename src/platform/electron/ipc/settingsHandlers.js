const { ipcMain } = require("electron");

function getRuntimeSettingDefault(key, defaultValue) {
  const runtimeDefaults = {
    backend_url: process.env.CAPSWRITER_BACKEND_URL || process.env.VITE_BACKEND_URL || "",
    tts_base_url: process.env.CAPSWRITER_TTS_BASE_URL || process.env.VITE_TTS_BASE_URL || "",
    server_llm_url: process.env.QWEN_ROUTER_SERVER_LLM_URL || process.env.CAPSWRITER_SERVER_LLM_URL || "",
  };
  const value = runtimeDefaults[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return defaultValue;
}

function registerSettingsHandlers(ctx) {
  ipcMain.handle("get-config", () => ctx.environmentManager.exportConfig());
  ipcMain.handle("validate-environment", () => ctx.environmentManager.validateEnvironment());

  ipcMain.handle("get-setting", (_event, key, defaultValue) => {
    return ctx.databaseManager.getSetting(key, getRuntimeSettingDefault(key, defaultValue));
  });

  const saveSetting = (_event, key, value) => {
    const result = ctx.databaseManager.setSetting(key, value);
    ctx.emitSettingsUpdate({ key, value, ts: Date.now() });
    return result;
  };

  ipcMain.handle("set-setting", saveSetting);
  ipcMain.handle("save-setting", saveSetting);
  ipcMain.handle("get-all-settings", () => ctx.databaseManager.getAllSettings());
  ipcMain.handle("get-settings", () => ctx.databaseManager.getAllSettings());
  ipcMain.handle("reset-settings", () => {
    const result = ctx.databaseManager.resetSettings();
    ctx.emitSettingsUpdate({ reset: true, ts: Date.now() });
    return result;
  });
}

module.exports = { registerSettingsHandlers };
