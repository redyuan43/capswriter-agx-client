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
  // WorkBuddy 桌面端（Electron）的对话输入框同样是可安全接收多行文本的目标
  // 注意：非 Linux 平台 resolveTerminalState 直接返回 null（textPolishHandlers.js:6），
  // 多行文本一律只复制，因此这里的期望值仍是 0
  windowClass = 'workbuddy WorkBuddy'; await paste({}, 'line1\nline2');
  assert.equal(pasted, process.platform === 'linux' ? 2 : 0);
  await paste({}, 'single line'); assert.equal(pasted, process.platform === 'linux' ? 3 : 1);
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

test('相同会话 IPC 重复回调不取消原任务；任务取消不取消其他预览', async () => {
  let finish, calls=0;
  const rows=new Map();
  const ctx={databaseManager:{getSetting:(_key,fallback)=>fallback,
    createSpeechRecord:(id,text)=>{const row={id:1,raw_text:text};rows.set(id,row);return row;},
    updateSpeechRecord:(id,patch)=>Object.assign(rows.get(id)||{},patch)},
    textPolisher:{polish:async text=>({text,stages:[]}),naturalFormatter:{format:async()=>{calls++;return new Promise(r=>{finish=r;});}}}};
  registerTextPolishHandlers(ctx,ipcMain);
  const event={sender:{id:20}};
  const options={mode:'natural',live:true,sessionId:'same'};
  const a=handlers.get('polish-text')(event,'原始输入',options);
  await new Promise(r=>setImmediate(r));
  const b=handlers.get('polish-text')(event,'重复回调',options);
  finish({text:'原始输入。',degraded:null});
  assert.notEqual((await a).degraded,'cancelled'); assert.notEqual((await b).degraded,'cancelled'); assert.equal(calls,1);
  let cancelled=false;
  ctx.textPolisher.polish=async(text,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve({text,degraded:'cancelled'});}));
  const preview=handlers.get('polish-text')(event,'其他预览',{mode:'prompt'});
  handlers.get('cancel-text-polish')(event,{jobId:'same'});
  assert.equal(cancelled,false);
  handlers.get('cancel-text-polish')(event);await preview; assert.equal(cancelled,true);
});
