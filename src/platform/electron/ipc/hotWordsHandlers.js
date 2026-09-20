const { ipcMain } = require("electron");

function registerHotWordsHandlers(ctx, ipcMainImpl = ipcMain) {
  ipcMainImpl.handle("get-hot-words", () => {
    if (!ctx.hotWordsStore) {
      // 曾经因为漏了 this.hotWordsStore 的搬运，这里静默返回空表，
      // 导致热词全程不生效且日志里毫无痕迹。不再沉默。
      ctx.logger?.("warn", "热词存储未接入 ctx，本次录音将不带热词");
      return { terms: [], hotword: "", count: 0, path: "", degraded: "store_unavailable" };
    }
    return {
      terms: ctx.hotWordsStore.list(),
      hotword: ctx.hotWordsStore.toHotwordString(),
      count: ctx.hotWordsStore.entries.length,
      path: ctx.hotWordsStore.filePath,
    };
  });

  ipcMainImpl.handle("reload-hot-words", () => {
    if (!ctx.hotWordsStore) return 0;
    return ctx.hotWordsStore.load();
  });

  // 剪贴板学到的术语直接落到本地词表，不依赖服务端 learn 接口
  // （腾讯-only 的 ASR 服务没有 /api/hotwords/learn 路由，那条路是断的）
  ipcMainImpl.handle("add-hot-words", (_event, terms) => {
    if (!ctx.hotWordsStore) {
      return { added: 0, total: 0, persisted: false, degraded: "store_unavailable" };
    }
    try {
      return ctx.hotWordsStore.add(terms);
    } catch (error) {
      ctx.logger?.("warn", "热词写入失败:", error?.message || error);
      return { added: 0, total: ctx.hotWordsStore.entries.length, persisted: false, degraded: error?.message || String(error) };
    }
  });
}

module.exports = { registerHotWordsHandlers };
