const { ipcMain } = require("electron");

function registerM5BridgeHandlers(ctx, ipcMainImpl = ipcMain) {
  ipcMainImpl.handle("repair-m5-bluetooth-device", (_event, mac) =>
    ctx.m5VoiceBridge.repairBluetoothDevice(mac, {
      confirmCleanup: true,
      forceCleanup: true,
    })
  );
}

module.exports = { registerM5BridgeHandlers };
