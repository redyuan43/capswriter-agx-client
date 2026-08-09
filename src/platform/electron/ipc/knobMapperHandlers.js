const { ipcMain } = require("electron");

function registerKnobMapperHandlers(ctx) {
  ipcMain.handle("get-knob-mapper-status", () => ctx.knobMapperManager.getStatus());
  ipcMain.handle("list-knob-mapper-devices", () => ctx.knobMapperManager.listDevices());
  ipcMain.handle("start-knob-mapper", () => ctx.knobMapperManager.start({ automatic: false }));
  ipcMain.handle("stop-knob-mapper", () => ctx.knobMapperManager.stop());
  ipcMain.handle("restart-knob-mapper", () => ctx.knobMapperManager.restart());
  ipcMain.handle("set-knob-mapper-enabled", (_event, enabled) =>
    ctx.knobMapperManager.setEnabled(Boolean(enabled))
  );
}

module.exports = { registerKnobMapperHandlers };
