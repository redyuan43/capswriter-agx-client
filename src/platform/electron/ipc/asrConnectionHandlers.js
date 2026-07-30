const { ipcMain } = require("electron");

function testWebSocketConnection(connection, timeoutMs = 10000) {
  if (typeof WebSocket === "undefined") {
    return Promise.reject(new Error("当前运行环境不支持 WebSocket 连接测试"));
  }
  const protocols = connection.token ? ["qwen3-asr-v1", `auth.${connection.token}`] : [];
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve({ success: true, profileId: connection.id, url: connection.url });
    };
    const timer = setTimeout(() => finish(new Error("ASR 连接测试超时")), timeoutMs);
    try {
      socket = protocols.length ? new WebSocket(connection.url, protocols) : new WebSocket(connection.url);
      socket.onopen = () => finish();
      socket.onerror = () => finish(new Error("ASR WebSocket 连接或认证失败"));
      socket.onclose = (event) => {
        if (!settled) finish(new Error(event?.reason || `ASR WebSocket 提前关闭 (${event?.code || "unknown"})`));
      };
    } catch (error) {
      finish(error);
    }
  });
}

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
  ipcMain.handle("test-asr-connection-profile", async (_event, profile, options = {}) => {
    const connection = ctx.asrConnectionProfiles.getConnectionForProfile(profile, options);
    return testWebSocketConnection(connection);
  });
}

module.exports = { registerAsrConnectionHandlers, testWebSocketConnection };
