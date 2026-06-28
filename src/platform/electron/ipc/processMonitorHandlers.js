const { ipcMain } = require("electron");

function forwardMonitorEvents(ctx) {
  if (!ctx.processMonitorManager) return;

  const emitToSettings = (channel, payload) => {
    if (ctx.windowManager.settingsWindow && !ctx.windowManager.settingsWindow.isDestroyed()) {
      ctx.windowManager.settingsWindow.webContents.send(channel, payload);
    }
  };

  ctx.processMonitorManager.on("status-update", status => emitToSettings("monitor-status-update", status));
  ctx.processMonitorManager.on("alert", alert => emitToSettings("monitor-alert", alert));
  ctx.processMonitorManager.on("error", error => emitToSettings("monitor-error", error));
  ctx.processMonitorManager.on("process-exited", data => emitToSettings("monitor-process-exited", data));
  ctx.processMonitorManager.on("monitor-stopped", data => emitToSettings("monitor-stopped", data));
}

function registerProcessMonitorHandlers(ctx) {
  ipcMain.handle("get-monitor-configs", async () => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return { success: true, configs: await ctx.processMonitorManager.loadConfigs() };
    } catch (error) {
      ctx.logger?.error("获取监控配置失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("add-monitor-config", async (_event, config) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return { success: true, config: await ctx.processMonitorManager.addConfig(config) };
    } catch (error) {
      ctx.logger?.error("添加监控配置失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("update-monitor-config", async (_event, id, updates) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return { success: true, config: await ctx.processMonitorManager.updateConfig(id, updates) };
    } catch (error) {
      ctx.logger?.error("更新监控配置失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("delete-monitor-config", async (_event, id) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      await ctx.processMonitorManager.deleteConfig(id);
      return { success: true };
    } catch (error) {
      ctx.logger?.error("删除监控配置失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("start-monitor", async (_event, id) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return await ctx.processMonitorManager.startMonitor(id);
    } catch (error) {
      ctx.logger?.error("启动监控失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-monitor", async (_event, id) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return ctx.processMonitorManager.stopMonitor(id);
    } catch (error) {
      ctx.logger?.error("停止监控失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-monitor-status", async (_event, id) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return { success: true, status: ctx.processMonitorManager.getMonitorStatus(id) };
    } catch (error) {
      ctx.logger?.error("获取监控状态失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-all-monitors-status", async () => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return { success: true, statuses: ctx.processMonitorManager.getAllMonitorsStatus() };
    } catch (error) {
      ctx.logger?.error("获取所有监控状态失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("is-monitor-running", async (_event, id) => {
    try {
      if (!ctx.processMonitorManager) return { success: false, error: "进程监控管理器未初始化" };
      return { success: true, running: ctx.processMonitorManager.isRunning(id) };
    } catch (error) {
      ctx.logger?.error("检查监控运行状态失败:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { forwardMonitorEvents, registerProcessMonitorHandlers };
