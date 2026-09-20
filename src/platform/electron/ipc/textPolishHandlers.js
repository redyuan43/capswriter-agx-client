const { ipcMain } = require("electron");
const { isTerminalWindow } = require("../../../helpers/terminalFocus");

/**
 * 判断录音目标窗口是不是终端。返回三态：
 *   true  = 确认是终端
 *   false = 确认不是终端
 *   null  = 判断不出来（未知）
 *
 * 用 windowManager 在录音开始时记下的活动窗口（悬浮球是非聚焦的，
 * 所以那个窗口就是最终粘贴的目标），取它的 WM_CLASS 来判断。
 *
 * 为什么未知必须单列一态：长文本整理会插换行，而终端里换行等于回车执行。
 * "读不到窗口"和"不是终端"是两件事，混成一个 false 就等于在信息不足时
 * 照样排版——2026-09-20 端到端回放抓到过这个方向性错误。未知时调用方
 * 会跳过整理，代价只是这次不分段，而不是往终端里粘一串命令。
 *
 * 非 Linux 平台没有终端识别的实现，直接返回 false（维持原有行为，
 * 不能因为没实现这个判据就把功能整个关掉）。
 */
function resolveTerminalState(ctx) {
  if (process.platform !== "linux") return false;
  try {
    const windowId = ctx.windowManager?.previousActiveWindow;
    if (!windowId) return null;
    const meta = ctx.clipboardManager?.getLinuxWindowMeta?.(windowId);
    if (!meta || (!meta.windowClass && !meta.windowTitle)) return null;
    return isTerminalWindow(meta.windowClass, meta.windowTitle);
  } catch (error) {
    ctx.logger?.debug?.("判断前台窗口类型失败", { error: error?.message || String(error) });
    return null;
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
        ? { ...options, longFormat: { ...options.longFormat, isTerminal: resolveTerminalState(ctx) } }
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
