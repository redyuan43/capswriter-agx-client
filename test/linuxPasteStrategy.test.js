const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const spawned = [];
let spawnBehavior = 'close-ok';

function fakeSpawn(command, args) {
  const handlers = {};
  const stderrHandlers = [];
  const proc = {
    stdout: { on() {} },
    stderr: { on(event, handler) { if (event === 'data') stderrHandlers.push(handler); } },
    on(event, handler) { handlers[event] = handler; return proc; },
    kill() {},
  };
  spawned.push({ command, args });
  process.nextTick(() => {
    if (command === 'ydotool' && spawnBehavior === 'ydotool-missing') {
      handlers.error?.({ message: 'spawn ydotool ENOENT', code: 'ENOENT' });
      return;
    }
    if (command === 'ydotool' && spawnBehavior === 'ydotool-runtime-error') {
      // 二进制存在，只是运行期失败（例如 ydotoold socket 没起来）——不能被当成「工具缺失」
      for (const handler of stderrHandlers) {
        handler(Buffer.from('failed to connect to ydotoold socket: No such file or directory'));
      }
      handlers.close?.(1);
      return;
    }
    handlers.close?.(0);
  });
  return proc;
}

const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { clipboard: { readText: () => '', writeText() {} } };
  if (name === 'child_process') return { spawn: fakeSpawn, execSync: () => '' };
  return originalLoad.call(this, name, ...args);
};
const ClipboardManager = require('../src/helpers/clipboard');
Module._load = originalLoad;

function createManager({ settings = {} } = {}) {
  const saved = [];
  const manager = new ClipboardManager({ info() {} });
  manager.setDatabaseManager({
    getSetting: (key, fallback) => (key in settings ? settings[key] : fallback),
    setSetting: (key, value) => saved.push({ key, value }),
  });
  return { manager, saved };
}

test('WorkBuddy 家族走规则而非缓存，并优先 Chromium 的 ctrl+v', () => {
  const { manager } = createManager();
  manager.pasteMethodMap['workbuddy workbuddy'] = 'shift_insert';

  const strategy = manager.chooseLinuxPasteMethods('workbuddy WorkBuddy', 'WorkBuddy');
  assert.equal(strategy.preferredMethod, 'ctrl_v');
  assert.equal(strategy.source, 'workbuddy_rule');
  assert.equal(strategy.cacheIgnored, true);
  assert.deepEqual(strategy.sequence, ['ctrl_v', 'ctrl_shift_v', 'shift_insert']);

  delete manager.pasteMethodMap['workbuddy workbuddy'];
  const withoutCache = manager.chooseLinuxPasteMethods('workbuddy WorkBuddy', 'WorkBuddy');
  assert.equal(withoutCache.preferredMethod, 'ctrl_v');
  assert.equal(withoutCache.cacheIgnored, false);

  for (const windowClass of ['CodeBuddy', 'buddycn']) {
    assert.equal(manager.chooseLinuxPasteMethods(windowClass, '').source, 'workbuddy_rule');
  }
});

test('WorkBuddy 家族的粘贴方法不写回缓存', () => {
  const { manager, saved } = createManager();
  manager.rememberLinuxPasteMethod('workbuddy WorkBuddy', 'shift_insert');
  assert.equal(manager.pasteMethodMap['workbuddy workbuddy'], undefined);
  assert.equal(saved.length, 0);

  manager.rememberLinuxPasteMethod('some-editor', 'ctrl_shift_v');
  assert.equal(manager.pasteMethodMap['some-editor'], 'ctrl_shift_v');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, 'clipboard_paste_method_map');
});

test('既有终端、Remmina、微信与默认窗口的粘贴策略不回归', () => {
  const { manager } = createManager();
  assert.equal(manager.chooseLinuxPasteMethods('gnome-terminal', 'bash').source, 'terminal_rule');
  assert.equal(manager.chooseLinuxPasteMethods('remmina', '').preferredMethod, 'ctrl_shift_v');
  assert.equal(manager.chooseLinuxPasteMethods('wechat', '微信').source, 'wechat_rule');
  const fallback = manager.chooseLinuxPasteMethods('some-editor', 'Editor');
  assert.equal(fallback.source, 'default_rule');
  assert.deepEqual(fallback.sequence, ['shift_insert', 'ctrl_shift_v', 'ctrl_v']);

  manager.pasteMethodMap['some-editor'] = 'ctrl_shift_v';
  const cached = manager.chooseLinuxPasteMethods('some-editor', 'Editor');
  assert.equal(cached.source, 'cache');
  assert.equal(cached.preferredMethod, 'ctrl_shift_v');
});

test('运行期失败不写死可用性缓存，仍会在下次重试', async () => {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  process.env.XDG_SESSION_TYPE = 'x11';
  try {
    const { manager } = createManager();
    spawnBehavior = 'ydotool-runtime-error';
    spawned.length = 0;

    const result = await manager.runLinuxPasteCommand('shift_insert', 'Shift+Insert');
    assert.equal(result.backend, 'xdotool');
    // 关键：ydotool 只是这一趟失败，不能被永久标记为「不存在」
    assert.equal(manager.isLinuxPasteToolAvailable('ydotool'), true);
  } finally {
    spawnBehavior = 'close-ok';
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
});

test('注入后端缺失只探测一次，后续直接走 xdotool', async () => {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  process.env.XDG_SESSION_TYPE = 'x11';
  try {
    const { manager } = createManager();
    spawnBehavior = 'ydotool-missing';
    spawned.length = 0;

    const first = await manager.runLinuxPasteCommand('shift_insert', 'Shift+Insert');
    assert.deepEqual(spawned.map((entry) => entry.command), ['ydotool', 'xdotool']);
    assert.equal(first.ok, true);
    assert.equal(first.backend, 'xdotool');
    assert.equal(first.fallbackFrom, 'ydotool');
    assert.match(first.fallbackError, /ENOENT/);
    assert.equal(manager.isLinuxPasteToolAvailable('ydotool'), false);

    spawned.length = 0;
    const second = await manager.runLinuxPasteCommand('shift_insert', 'Shift+Insert');
    assert.deepEqual(spawned.map((entry) => entry.command), ['xdotool']);
    assert.equal(second.ok, true);
    assert.match(second.fallbackError, /unavailable/);
  } finally {
    spawnBehavior = 'close-ok';
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
});
