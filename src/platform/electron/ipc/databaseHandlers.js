const { ipcMain } = require("electron");

function registerDatabaseHandlers(ctx) {
  ipcMain.handle("save-transcription", (_event, data) => ctx.databaseManager.saveTranscription(data));
  ipcMain.handle("get-transcriptions", (_event, limit, offset) => ctx.databaseManager.getTranscriptions(limit, offset));
  ipcMain.handle("get-transcription", (_event, id) => ctx.databaseManager.getTranscriptionById(id));
  ipcMain.handle("delete-transcription", (_event, id) => ctx.databaseManager.deleteTranscription(id));
  ipcMain.handle("search-transcriptions", (_event, query, limit) => ctx.databaseManager.searchTranscriptions(query, limit));
  ipcMain.handle("get-transcription-stats", () => ctx.databaseManager.getTranscriptionStats());
  ipcMain.handle("clear-all-transcriptions", () => ctx.databaseManager.clearAllTranscriptions());

  ipcMain.handle("save-translated-clipboard", (_event, originalText, translatedText) => {
    try {
      return ctx.databaseManager.saveTranslatedClipboard(originalText, translatedText);
    } catch (error) {
      ctx.logger.error("保存剪贴板翻译历史失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-translated-clipboard-history", (_event, limit, offset) => {
    try {
      return ctx.databaseManager.getTranslatedClipboardHistory(limit, offset);
    } catch (error) {
      ctx.logger.error("获取剪贴板翻译历史失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("delete-translated-clipboard-item", (_event, id) => {
    try {
      return ctx.databaseManager.deleteTranslatedClipboardItem(id);
    } catch (error) {
      ctx.logger.error("删除剪贴板翻译历史失败:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("clear-translated-clipboard-history", () => {
    try {
      return ctx.databaseManager.clearTranslatedClipboardHistory();
    } catch (error) {
      ctx.logger.error("清空剪贴板翻译历史失败:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerDatabaseHandlers };
