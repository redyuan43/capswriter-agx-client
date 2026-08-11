const { ipcMain } = require("electron");

function registerDeviceMappingHandlers(ctx) {
  ipcMain.handle("get-device-mapping-status", (_event, deviceId) => {
    const status = ctx.m5VoiceBridge.deviceMapping.getStatus(deviceId);
    const device = ctx.m5VoiceBridge.listDevices().find((candidate) =>
      candidate.device_id.toLowerCase() === status.device_id
    ) || null;
    return { ...status, connected: Boolean(device), device };
  });
  ipcMain.handle("save-device-mapping-profile", (_event, deviceId, profile) =>
    ctx.m5VoiceBridge.deviceMapping.applyProfile(deviceId, profile)
  );
  ipcMain.handle("reset-device-mapping-profile", (_event, deviceId) => {
    ctx.m5VoiceBridge.deviceMapping.resetProfile(deviceId);
    return ctx.m5VoiceBridge.deviceMapping.applyProfile(deviceId);
  });
}

module.exports = { registerDeviceMappingHandlers };
