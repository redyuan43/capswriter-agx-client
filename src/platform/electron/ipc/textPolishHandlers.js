const { ipcMain } = require("electron");
const { isTerminalWindow } = require("../../../helpers/terminalFocus");

/**
 * 判断录音目标窗口是不是终端。
 *
 * 用 windowManager 在录音开始时记下的活动窗口（悬浮球是非聚焦的，
 * 所以那个窗口就是最终粘贴的目标），取它的 WM_CLASS 来判断。
 *
 * 为什么必须先判断：长文本整理会插换行，而终端里换行等于回车执行。
 * 拿不到窗口信息时保守返回 false，但整理只在"明确不是终端"时才跑，
 * 所以宁可漏判也不误判。
 */
function isFocusedWindowTerminal(ctx) {
  try {
    const windowId = ctx.windowManager?.previousActiveWindow;
    if (!windowId) return false;
    const meta = ctx.clipboardManager?.getLinuxWindowMeta?.(windowId);
    if (!meta) return false;
    return isTerminalWindow(meta.windowClass, meta.windowTitle);
  } catch (error) {
    ctx.logger?.debug?.("判断前台窗口类型失败", { error: error?.message || String(error) });
    return false;
  }
}

function registerTextPolishHandlers(ctx, ipcMainImpl = ipcMain) {
  ipcMainImpl.handle("polish-text", async (_event, text, options = {}) => {
    if (!ctx.textPolisher) {
      return { text: text || "", changed: false, stages: [], degraded: "polisher_unavailable" };
    }
    try {
      // 只有真正要长文本整理时才去查窗口，省掉无谓的 xprop 调用
      const payload = options.longFormat?.enabled
        ? { ...options, longFormat: { ...options.longFormat, isTerminal: isFocusedWindowTerminal(ctx) } }
        : options;
      return await ctx.textPolisher.polish(text, payload);
    } catch (error) {
      ctx.logger?.warn("文本整理失败，已回退原文:", error?.message || error);
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

  // 长文本整理服务的可用性探测（设置页展示用）
  ipcMainImpl.handle("probe-long-text-service", async () => {
    const formatter = ctx.textPolisher?.longFormatter;
    if (!formatter) return { available: false, error: "formatter_unavailable" };
    return formatter.probe();
  });
}

module.exports = { registerTextPolishHandlers };
