const { app, BrowserWindow, ipcMain, shell } = require("electron");

function registerRendererLogger(ctx, channel) {
  ipcMain.handle(channel, (_event, level, message, data) => {
    const loggerFn = typeof ctx.logger[level] === "function" ? ctx.logger[level].bind(ctx.logger) : ctx.logger.info.bind(ctx.logger);
    loggerFn(`[渲染进程] ${message}`, data ?? null);
    return true;
  });
}

function registerMiscHandlers(ctx) {
  ipcMain.handle("start-recording", async () => ({ success: true }));
  ipcMain.handle("stop-recording", async () => ({ success: true }));
  ipcMain.handle("process-text", async (_event, text, mode = "optimize") => ctx.processTextWithAI(text, mode));
  ipcMain.handle("check-ai-status", async (_event, testConfig = null) => ctx.checkAIStatus(testConfig));

  ctx.hotkeyRegisteredSenders = new Set();

  ipcMain.handle("register-hotkey", (event, hotkey) => {
    try {
      if (!ctx.hotkeyManager) return { success: false, error: "热键管理器未初始化" };
      const senderId = event.sender.id;
      if (ctx.hotkeyRegisteredSenders.has(senderId)) {
        ctx.logger.info(`发送者 ${senderId} 已注册过热键，跳过重复注册`);
        return { success: true };
      }
      const success = ctx.hotkeyManager.registerHotkey(hotkey, () => {
        if (ctx.windowManager?.mainWindow && !ctx.windowManager.mainWindow.isDestroyed()) {
          ctx.windowManager.mainWindow.webContents.send("hotkey-triggered", { hotkey });
        }
      });
      if (success) {
        ctx.hotkeyRegisteredSenders.add(senderId);
        event.sender.on("destroyed", () => ctx.hotkeyRegisteredSenders.delete(senderId));
      }
      return { success };
    } catch (error) {
      ctx.logger.error("注册热键失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("unregister-hotkey", (_event, hotkey) => {
    try {
      if (!ctx.hotkeyManager) return { success: false, error: "热键管理器未初始化" };
      return { success: ctx.hotkeyManager.unregisterHotkey(hotkey) };
    } catch (error) {
      ctx.logger.error("注销热键失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-current-hotkey", () => {
    try {
      if (!ctx.hotkeyManager) return "CommandOrControl+Shift+Space";
      const hotkeys = ctx.hotkeyManager.getRegisteredHotkeys();
      return hotkeys.find(key => key !== "F2") || "CommandOrControl+Shift+Space";
    } catch (error) {
      ctx.logger.error("获取当前热键失败:", error);
      return "CommandOrControl+Shift+Space";
    }
  });

  ipcMain.handle("register-f2-hotkey", event => {
    try {
      if (!ctx.hotkeyManager) return { success: false, error: "热键管理器未初始化" };
      const senderId = event.sender.id;
      if (ctx.f2RegisteredSenders.has(senderId)) return { success: true };
      if (ctx.f2RegisteredSenders.size === 0) {
        const success = ctx.hotkeyManager.registerF2DoubleClick(data => {
          ctx.f2RegisteredSenders.forEach(id => {
            const win = BrowserWindow.getAllWindows().find(window => window.webContents.id === id);
            if (win && !win.isDestroyed()) {
              win.webContents.send("f2-double-click", data);
            }
          });
        });
        if (!success) return { success: false, error: "F2热键注册失败" };
      }
      ctx.f2RegisteredSenders.add(senderId);
      event.sender.on("destroyed", () => {
        ctx.f2RegisteredSenders.delete(senderId);
        if (ctx.f2RegisteredSenders.size === 0) {
          ctx.hotkeyManager.unregisterHotkey("F2");
        }
      });
      return { success: true };
    } catch (error) {
      ctx.logger.error("注册F2热键失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("unregister-f2-hotkey", event => {
    try {
      if (!ctx.hotkeyManager || !ctx.f2RegisteredSenders.has(event.sender.id)) {
        return { success: false, error: "热键管理器未初始化或未注册" };
      }
      ctx.f2RegisteredSenders.delete(event.sender.id);
      if (ctx.f2RegisteredSenders.size === 0) {
        return { success: ctx.hotkeyManager.unregisterHotkey("F2") };
      }
      return { success: true };
    } catch (error) {
      ctx.logger.error("注销F2热键失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("set-recording-state", (_event, isRecording) => {
    try {
      if (!ctx.hotkeyManager) return { success: false, error: "热键管理器未初始化" };
      ctx.hotkeyManager.setRecordingState(isRecording);
      return { success: true };
    } catch (error) {
      ctx.logger.error("设置录音状态失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-recording-state", () => {
    try {
      if (!ctx.hotkeyManager) return { success: false, error: "热键管理器未初始化" };
      return { success: true, isRecording: ctx.hotkeyManager.getRecordingState() };
    } catch (error) {
      ctx.logger.error("获取录音状态失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("export-transcriptions", () => ({ success: true, path: "" }));
  ipcMain.handle("import-settings", () => ({ success: true }));
  ipcMain.handle("export-settings", () => ({ success: true, path: "" }));

  ipcMain.handle("get-system-info", () => ({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron
  }));

  ipcMain.handle("check-permissions", async () => {
    try {
      const hasAccessibility = await ctx.clipboardManager.checkAccessibilityPermissions();
      return { microphone: true, accessibility: hasAccessibility };
    } catch (error) {
      ctx.logger.error("检查权限失败:", error);
      return { microphone: false, accessibility: false, error: error.message };
    }
  });

  ipcMain.handle("request-permissions", async () => {
    try {
      if (process.platform === "darwin") {
        ctx.clipboardManager.openSystemSettings();
      }
      return { success: true };
    } catch (error) {
      ctx.logger.error("请求权限失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("test-accessibility-permission", async () => {
    try {
      await ctx.clipboardManager.pasteText("语音转写权限测试");
      return { success: true, message: "辅助功能权限测试成功" };
    } catch (error) {
      ctx.logger.error("辅助功能权限测试失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-system-permissions", () => {
    try {
      if (process.platform === "darwin") {
        ctx.clipboardManager.openSystemSettings();
        return { success: true };
      }
      return { success: false, error: "当前平台不支持自动打开权限设置" };
    } catch (error) {
      ctx.logger.error("打开系统权限设置失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("check-for-updates", () => ({ hasUpdate: false }));
  registerRendererLogger(ctx, "log");
  registerRendererLogger(ctx, "log-message");

  ipcMain.handle("get-debug-info", () => ({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    appVersion: app.getVersion()
  }));

  ipcMain.handle("detect-language", () => ({ language: "zh-CN", confidence: 0.95 }));
  ipcMain.handle("segment-chinese", (_event, text) => ({ segments: text.split("") }));
  ipcMain.handle("add-punctuation", (_event, text) => ({ text }));
  ipcMain.handle("convert-audio-format", (_event, audioData) => ({ success: true, data: audioData }));
  ipcMain.handle("enhance-audio", (_event, audioData) => ({ success: true, data: audioData }));
  ipcMain.handle("download-model", async () => ({ success: false, error: "本地模型管理已移除，请使用 HTTP 后端" }));
  ipcMain.handle("get-available-models", () => ({ models: [] }));
  ipcMain.handle("get-current-model", async () => ({ model: "remote-backend", status: "managed-remotely" }));
  ipcMain.handle("switch-model", () => ({ success: false, error: "模型由后端服务管理，不支持在客户端切换" }));
  ipcMain.handle("get-performance-stats", () => ({ stats: {} }));
  ipcMain.handle("clear-performance-stats", () => ({ success: true }));
  ipcMain.handle("report-error", (_event, error) => (ctx.logger.error("渲染进程错误:", error), true));

  if (process.env.NODE_ENV === "development") {
    ipcMain.handle("open-dev-tools", event => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) window.webContents.openDevTools();
    });
    ipcMain.handle("reload-window", event => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) window.reload();
    });
  }

  ipcMain.handle("get-app-logs", (_event, lines = 100) => {
    try {
      if (ctx.logger?.getRecentLogs) return { success: true, logs: ctx.logger.getRecentLogs(lines) };
      return { success: false, error: "日志管理器不可用" };
    } catch (error) {
      ctx.logger.error("获取应用日志失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-log-file-path", () => {
    try {
      if (ctx.logger?.getLogFilePath) return { success: true, appLogPath: ctx.logger.getLogFilePath() };
      return { success: false, error: "日志管理器不可用" };
    } catch (error) {
      ctx.logger.error("获取日志文件路径失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-log-file", () => {
    try {
      if (!ctx.logger) return { success: false, error: "日志管理器不可用" };
      shell.showItemInFolder(ctx.logger.getLogFilePath());
      return { success: true };
    } catch (error) {
      ctx.logger.error("打开日志文件失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-system-debug-info", () => {
    try {
      const debugInfo = {
        system: {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          appVersion: app.getVersion()
        },
        environment: {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.PATH,
          PYTHON_PATH: process.env.PYTHON_PATH,
          AI_API_KEY: "通过控制面板设置",
          AI_BASE_URL: "通过控制面板设置",
          AI_MODEL: "通过控制面板设置"
        }
      };
      if (ctx.logger?.getSystemInfo) {
        debugInfo.loggerInfo = ctx.logger.getSystemInfo();
      }
      return { success: true, debugInfo };
    } catch (error) {
      ctx.logger.error("获取系统调试信息失败:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerMiscHandlers };
