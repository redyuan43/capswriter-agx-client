const { ipcMain } = require("electron");

function registerTextPolishHandlers(ctx, ipcMainImpl = ipcMain) {
  ipcMainImpl.handle("polish-text", async (_event, text, options = {}) => {
    if (!ctx.textPolisher) {
      return { text: text || "", changed: false, stages: [], degraded: "polisher_unavailable" };
    }
    try {
      return await ctx.textPolisher.polish(text, options);
    } catch (error) {
      ctx.logger?.("warn", "文本整理失败，已回退原文:", error?.message || error);
      return {
        text: text || "",
        changed: false,
        stages: [],
        degraded: error?.message || String(error),
      };
    }
  });

  ipcMainImpl.handle("reload-hot-rules", () => {
    if (!ctx.textPolisher) return 0;
    return ctx.textPolisher.loadRules();
  });
}

module.exports = { registerTextPolishHandlers };
