const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const handlers = new Map();
const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
const originalLoad = Module._load;
Module._load = function (name, ...args) { return name === 'electron' ? { ipcMain } : originalLoad.call(this, name, ...args); };
const { registerClipboardHandlers } = require('../src/platform/electron/ipc/clipboardHandlers');
const { registerTextPolishHandlers } = require('../src/platform/electron/ipc/textPolishHandlers');
Module._load = originalLoad;

test('多行终端/未知窗口仅复制，已知编辑器粘贴，保留单行输入', async () => {
  let windowClass = 'gnome-terminal', pasted = 0, copied = 0;
  const ctx = { windowManager: { previousActiveWindow: '123' }, clipboardManager: {
    getLinuxWindowMeta: () => ({ windowClass }), copyText: async () => { copied++; return { success: true }; },
    pasteText: async () => { pasted++; return { success: true }; },
  } };
  registerClipboardHandlers(ctx);
  const paste = handlers.get('paste-text');
  assert.equal((await paste({}, 'line1\nline2')).mode, 'copied');
  windowClass = ''; assert.equal((await paste({}, 'line1\nline2')).mode, 'copied');
  assert.equal(pasted, 0); assert.equal(copied, 2);
  windowClass = 'unrecognized-shell';
  assert.equal((await paste({}, 'line1\nline2')).mode, 'copied');
  assert.equal((await handlers.get('insert-text-directly')({}, 'line1\nline2')).mode, 'copied');
  assert.equal(pasted, 0);
  windowClass = 'code'; await paste({}, 'line1\nline2');
  assert.equal(pasted, process.platform === 'linux' ? 1 : 0);
  await paste({}, 'single line'); assert.equal(pasted, process.platform === 'linux' ? 2 : 1);
});

test('取消当前发送者的整理，并阻止替换模式漏掉同一取消入口', async () => {
  const seen = [];
  const ctx = { databaseManager: { getSetting: () => 'prompt' }, textPolisher: {
    polish: async (text, options) => {
      seen.push({ text, options });
      return new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ text, degraded: 'cancelled' }), { once: true }));
    },
  } };
  registerTextPolishHandlers(ctx, ipcMain);
  const event = { sender: { id: 10 } };
  const first = handlers.get('polish-text')(event, '第一段');
  const second = handlers.get('process-text')(event, '第二段', 'prompt');
  assert.equal((await first).degraded, 'cancelled');
  handlers.get('cancel-text-polish')(event);
  assert.equal((await second).success, false);
  assert.equal(seen[1].options.mode, 'prompt');
});
