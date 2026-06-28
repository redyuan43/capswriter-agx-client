const { ipcMain } = require("electron");

function registerClipboardHandlers(ctx) {
  ipcMain.handle("copy-text", async (_event, text) => {
    try {
      return await ctx.clipboardManager.copyText(text);
    } catch (error) {
      ctx.logger.error("复制文本失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("paste-text", async (_event, text) => ctx.clipboardManager.pasteText(text));

  ipcMain.handle("insert-text-directly", async (_event, text) => {
    try {
      return await ctx.clipboardManager.insertTextDirectly(text);
    } catch (error) {
      ctx.logger.error("直接插入文本失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("enable-macos-accessibility", async () => {
    try {
      if (process.platform === "darwin") {
        const result = await ctx.clipboardManager.enableMacOSAccessibility();
        return { success: result };
      }
      return { success: true, message: "非 macOS 平台，无需设置" };
    } catch (error) {
      ctx.logger.error("启用 macOS accessibility 失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("read-clipboard", async () => {
    try {
      const text = await ctx.clipboardManager.readClipboard();
      return { success: true, text };
    } catch (error) {
      ctx.logger.error("读取剪贴板失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("write-clipboard", async (_event, text) => {
    try {
      return await ctx.clipboardManager.writeClipboard(text);
    } catch (error) {
      ctx.logger.error("写入剪贴板失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-clipboard-history", () => []);
  ipcMain.handle("clear-clipboard-history", () => true);
}

module.exports = { registerClipboardHandlers };
