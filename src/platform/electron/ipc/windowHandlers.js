const { app, ipcMain, shell } = require("electron");

function registerWindowHandlers(ctx) {
  ipcMain.handle("hide-window", () => {
    ctx.windowManager.mainWindow?.hide();
    return true;
  });
  ipcMain.handle("hide-floating-ball", () => {
    if (ctx.windowManager?.hideFloatingBall) {
      ctx.windowManager.hideFloatingBall();
    }
    return true;
  });
  ipcMain.handle("resize-floating-ball", (_event, width, height) => {
    if (ctx.windowManager?.resizeFloatingBall) {
      return ctx.windowManager.resizeFloatingBall(width, height);
    }
    return false;
  });
  ipcMain.handle("show-window", () => {
    ctx.windowManager.mainWindow?.show();
    return true;
  });
  ipcMain.handle("minimize-window", () => {
    ctx.windowManager.mainWindow?.minimize();
    return true;
  });
  ipcMain.handle("close-window", () => {
    ctx.windowManager.mainWindow?.close();
    return true;
  });
  ipcMain.handle("move-window", (_event, x, y) => {
    if (ctx.windowManager.mainWindow) {
      const [currentX, currentY] = ctx.windowManager.mainWindow.getPosition();
      ctx.windowManager.mainWindow.setPosition(currentX + x, currentY + y);
    }
    return true;
  });

  ipcMain.handle("show-control-panel", () => (ctx.windowManager.showControlPanel(), true));
  ipcMain.handle("hide-control-panel", () => (ctx.windowManager.hideControlPanel(), true));
  ipcMain.handle("open-control-panel", () => (ctx.windowManager.showControlPanel(), true));
  ipcMain.handle("close-control-panel", () => (ctx.windowManager.hideControlPanel(), true));
  ipcMain.handle("open-history-window", () => (ctx.windowManager.showHistoryWindow(), true));
  ipcMain.handle("close-history-window", () => (ctx.windowManager.closeHistoryWindow(), true));
  ipcMain.handle("hide-history-window", () => (ctx.windowManager.hideHistoryWindow(), true));
  ipcMain.handle("open-settings-window", () => (ctx.windowManager.showSettingsWindow(), true));
  ipcMain.handle("close-settings-window", () => (ctx.windowManager.closeSettingsWindow(), true));
  ipcMain.handle("hide-settings-window", () => (ctx.windowManager.hideSettingsWindow(), true));
  ipcMain.handle("open-asr-admin-window", () => ctx.windowManager.showAsrAdminWindow());
  ipcMain.handle("close-app", () => app.quit());

  ipcMain.handle("show-item-in-folder", (_event, fullPath) => shell.showItemInFolder(fullPath));
  ipcMain.handle("open-external", (_event, url) => shell.openExternal(url));
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("get-app-path", (_event, name) => app.getPath(name));
}

module.exports = { registerWindowHandlers };
