const { ipcMain } = require("electron");
const {
  assertSettingWritable,
  readSetting,
  sanitizeStoredSettings,
} = require("../runtimeSettings");

function registerSettingsHandlers(ctx) {
  ipcMain.handle("get-config", () => ctx.environmentManager.exportConfig());
  ipcMain.handle("validate-environment", () => ctx.environmentManager.validateEnvironment());

  ipcMain.handle("get-setting", (_event, key, defaultValue) => {
    return readSetting(ctx.databaseManager, key, defaultValue);
  });

  const saveSetting = (_event, key, value) => {
    assertSettingWritable(key);
    const result = ctx.databaseManager.setSetting(key, value);
    ctx.emitSettingsUpdate({ key, value, ts: Date.now() });
    return result;
  };

  ipcMain.handle("set-setting", saveSetting);
  ipcMain.handle("save-setting", saveSetting);
  ipcMain.handle("get-all-settings", () => sanitizeStoredSettings(ctx.databaseManager.getAllSettings()));
  ipcMain.handle("get-settings", () => sanitizeStoredSettings(ctx.databaseManager.getAllSettings()));
  ipcMain.handle("reset-settings", () => {
    const result = ctx.databaseManager.resetSettings();
    ctx.emitSettingsUpdate({ reset: true, ts: Date.now() });
    return result;
  });
}

module.exports = { registerSettingsHandlers };
