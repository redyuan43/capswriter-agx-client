const { ipcMain } = require("electron");
const { isTerminalWindow } = require("../../../helpers/terminalFocus");

// true 为终端，false 为已知编辑器，null 为未知。未知目标的多行结果仅复制。
function resolveTerminalState(ctx) {
  if (process.platform !== "linux") return null;
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
  const active = new Map();
  ipcMainImpl.handle('cancel-text-polish', (event) => {
    active.get(event.sender.id)?.abort();
    active.delete(event.sender.id);
  });
  ipcMainImpl.handle('get-provider-status', () => ctx.providerSecrets?.status() || { configured: {} });
  ipcMainImpl.handle('save-provider-secrets', (_event, patch) => {
    if (!ctx.providerSecrets) throw new Error('凭据存储不可用');
    return ctx.providerSecrets.save(patch);
  });
  const polish = async (event, text, options = {}) => {
    if (!ctx.textPolisher) {
      return { text: text || "", changed: false, stages: [], degraded: "polisher_unavailable" };
    }
    const senderId = event.sender.id;
    active.get(senderId)?.abort();
    const controller = new AbortController();
    const onDestroyed = () => controller.abort();
    event.sender.once?.('destroyed', onDestroyed);
    active.set(senderId, controller);
    try {
      // 目标窗口影响交付方式，不阻止文本整理。
      const payload = { ...options, signal: controller.signal,
        mode: options.mode || ctx.databaseManager?.getSetting('text_processing_mode', 'light'),
        longFormat: { ...options.longFormat, isTerminal: resolveTerminalState(ctx) } };
      return await ctx.textPolisher.polish(text, payload);
    } catch (error) {
      ctx.logger?.warn("文本整理失败，已回退原文:", error?.message || error);
      return {
        text: text || "",
        changed: false,
        stages: [],
        degraded: error?.message || String(error),
      };
    } finally {
      event.sender.removeListener?.('destroyed', onDestroyed);
      if (active.get(senderId) === controller) active.delete(senderId);
    }
  };
  ipcMainImpl.handle('polish-text', polish);
  ipcMainImpl.handle('process-text', async (event, text, mode) => {
    const result = await polish(event, text, { mode: mode === 'prompt' ? 'prompt' : undefined, hotRule: true, longFormat: { enabled: true } });
    return { ...result, success: result.degraded !== 'cancelled', optimized_text: result.text };
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

module.exports = { registerTextPolishHandlers, resolveTerminalState };
