const { ipcMain } = require("electron");

function registerAsrConnectionHandlers(ctx) {
  ipcMain.handle("list-asr-connection-profiles", () => ctx.asrConnectionProfiles.list());
  ipcMain.handle("save-asr-connection-profile", (_event, profile, options = {}) => {
    const result = ctx.asrConnectionProfiles.save(profile, options);
    ctx.emitSettingsUpdate({ key: "asr_connection_profiles_v1", ts: Date.now() });
    return result;
  });
  ipcMain.handle("delete-asr-connection-profile", (_event, profileId) => {
    const result = ctx.asrConnectionProfiles.remove(String(profileId || ""));
    ctx.emitSettingsUpdate({ key: "asr_connection_profiles_v1", ts: Date.now() });
    return result;
  });
  ipcMain.handle("activate-asr-connection-profile", (_event, profileId) => {
    const result = ctx.asrConnectionProfiles.activate(String(profileId || ""));
    ctx.emitSettingsUpdate({ key: "asr_connection_profiles_v1", ts: Date.now() });
    return result;
  });
  ipcMain.handle("get-active-asr-connection", () => ctx.asrConnectionProfiles.getActiveConnection());
  ipcMain.handle("resolve-asr-connection-profile", (_event, profile, options = {}) =>
    ctx.asrConnectionProfiles.getConnectionForProfile(profile, options));
}

module.exports = { registerAsrConnectionHandlers };
