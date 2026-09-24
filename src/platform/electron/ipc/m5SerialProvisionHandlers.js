const { ipcMain } = require("electron");

const serialProvision = require("../../../helpers/m5SerialProvision");

const REMEMBERED_PROFILE_KEY = "m5_serial_wifi_profile_v1";

function registerM5SerialProvisionHandlers(ctx, ipcMainImpl = ipcMain) {
  ipcMainImpl.handle("m5-serial-list-devices", async () => {
    const ports = serialProvision.listEspressifPorts();
    const devices = [];
    for (const port of ports) {
      const probe = serialProvision.probeDevice(port.path);
      devices.push({
        path: port.path,
        id: port.id,
        provisionSupported: Boolean(probe.supported),
        state: probe.state || null,
        reason: probe.reason || null,
      });
    }
    return { success: true, devices };
  });

  ipcMainImpl.handle("m5-serial-host-info", async () => {
    const bridgeTarget = serialProvision.detectHostBridgeTarget();
    const wifiProfile = serialProvision.readHostWifiProfile();
    const remembered = await ctx.databaseManager.getSetting(
      REMEMBERED_PROFILE_KEY
    );
    return {
      success: true,
      bridgeTarget,
      wifiProfile,
      remembered: remembered || null,
    };
  });

  ipcMainImpl.handle(
    "m5-serial-provision",
    async (_event, payload = {}, options = {}) => {
      const ports = serialProvision.listEspressifPorts();
      if (!ports.length) {
        return {
          success: false,
          error: "未检测到 M5 设备（Espressif USB 串口）。请用 USB 线连接设备。",
        };
      }
      const remembered = await ctx.databaseManager.getSetting(
        REMEMBERED_PROFILE_KEY
      );
      const effective = {
        ssid: payload.ssid || (remembered && remembered.ssid) || "",
        password: payload.password || (remembered && remembered.password) || "",
        bridge: payload.bridge || {
          host:
            (serialProvision.detectHostBridgeTarget() || {}).host || "",
          port: 8765,
        },
        apply: payload.apply !== false,
      };
      try {
        const result = serialProvision.provisionDevice(
          ports[0].path,
          effective
        );
        if (result.success && effective.ssid && effective.password) {
          // 记住成功的档案（不含 bridge —— bridge 每台主机自动算）
          await ctx.databaseManager.setSetting(REMEMBERED_PROFILE_KEY, {
            ssid: effective.ssid,
            password: effective.password,
            savedAt: new Date().toISOString(),
          });
        }
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  );

  ipcMainImpl.handle("m5-serial-forget-profile", async () => {
    await ctx.databaseManager.setSetting(REMEMBERED_PROFILE_KEY, null);
    return { success: true };
  });
}

module.exports = {
  registerM5SerialProvisionHandlers,
  REMEMBERED_PROFILE_KEY,
};
