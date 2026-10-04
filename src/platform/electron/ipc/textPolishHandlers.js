const { ipcMain } = require("electron");
const { isTerminalWindow } = require("../../../helpers/terminalFocus");
const { SpeechJobs } = require('../../../helpers/speechJobs');

// true 为终端，false 为已知编辑器，null 为未知。未知目标的多行结果仅复制。
function resolveTerminalState(ctx) {
  if (process.platform !== "linux") return null;
  try {
    const windowId = ctx.windowManager?.previousActiveWindow;
    if (!windowId) return null;
    const meta = ctx.clipboardManager?.getLinuxWindowMeta?.(windowId);
    if (!meta || (!meta.windowClass && !meta.windowTitle)) return null;
    if (isTerminalWindow(meta.windowClass, meta.windowTitle)) return true;
    // 未命中终端名单不等于已确认可安全接收多行文本。
    const classes = String(meta.windowClass || '').toLowerCase().split(/\s+/);
    // workbuddy / codebuddy / buddycn 是 WorkBuddy 桌面端（Electron），其对话输入框
    // 是普通多行输入：此前被判为"未知窗口"，长口述结果只会复制到剪贴板而从不粘贴。
    const editors = new Set(['code', 'code-oss', 'vscodium', 'gedit', 'org.gnome.gedit',
      'org.gnome.texteditor', 'kate', 'kwrite', 'mousepad', 'leafpad', 'sublime_text',
      'libreoffice-writer', 'firefox', 'google-chrome', 'chromium', 'chromium-browser',
      'workbuddy', 'codebuddy', 'buddycn']);
    return classes.some(name => editors.has(name)) ? false : null;
  } catch (error) {
    ctx.logger?.debug?.("判断前台窗口类型失败", { error: error?.message || String(error) });
    return null;
  }
}

function registerTextPolishHandlers(ctx, ipcMainImpl = ipcMain) {
  const active = new Map();
  const owners = new Set();
  const qualityApproved = () => {
    const evidence = ctx.databaseManager?.getSetting('natural_model_approval', null);
    return ctx.databaseManager?.getSetting('natural_model_approved', false) === true &&
      ctx.textPolisher?.naturalFormatter?.isApproved?.(evidence) === true;
  };
  if (ctx.textPolisher?.naturalFormatter && ctx.databaseManager?.createSpeechRecord) {
    ctx.speechJobs = new SpeechJobs({ polisher: ctx.textPolisher, database: ctx.databaseManager,
      approved: qualityApproved });
  }
  ipcMainImpl.handle('cancel-text-polish', (event, options = {}) => {
    if (options.waitOnly) { ctx.speechJobs?.finishWaitingForOwner(event.sender.id); return; }
    if (options.jobId) { ctx.speechJobs?.cancel(options.jobId); return; }
    active.get(event.sender.id)?.abort();
    active.delete(event.sender.id);
    ctx.speechJobs?.cancelOwner(event.sender.id, { background: options.background !== false });
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
    if (!owners.has(senderId)) {
      owners.add(senderId);
      event.sender.once?.('destroyed', () => { ctx.speechJobs?.cancelOwner(senderId); owners.delete(senderId); });
    }
    const existing = options.live && options.sessionId && ctx.speechJobs?.jobs.get(options.sessionId);
    if (existing?.owner === senderId) return existing.foreground;
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
      if (payload.mode === 'natural' && payload.live && ctx.speechJobs) {
        const result = await ctx.speechJobs.run(text, payload, senderId);
        return { ...result, copyOnly: /[\r\n]/.test(result.text) && payload.longFormat.isTerminal !== false };
      }
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
  ipcMainImpl.handle('retry-speech-job', (event, recordId) => {
    const row = ctx.databaseManager.getTranscriptionById(recordId);
    if (!row?.session_id || !ctx.speechJobs) return { success: false, error: '记录不存在' };
    const previous = ctx.speechJobs.jobs.get(row.session_id);
    if (previous && !previous.done) return { success: false, error: '仍在整理中' };
    if ([...ctx.speechJobs.jobs.values()].some(j => !j.done && !j.foregroundReturned)) return { success: false, error: '正在处理新输入，请稍后重试' };
    ctx.speechJobs.jobs.delete(row.session_id);
    let metadata = {};
    try { metadata = JSON.parse(row.processing_json || '{}'); } catch { /* Old history may have no metadata. */ }
    return ctx.speechJobs.run(row.raw_text, { sessionId: row.session_id, mode: 'natural', backgroundOnly: true,
      segments: metadata.segments || [], words: metadata.words || [] }, event.sender.id);
  });
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
    const formatter = ctx.databaseManager?.getSetting('text_processing_mode', 'light') === 'natural'
      ? ctx.textPolisher?.naturalFormatter : ctx.textPolisher?.longFormatter;
    if (!formatter) return { available: false, error: "formatter_unavailable" };
    return { ...await formatter.probe(), qualityApproved: qualityApproved() };
  });
}

module.exports = { registerTextPolishHandlers, resolveTerminalState };
