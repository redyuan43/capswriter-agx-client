const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuitWatchdog, DEFAULT_QUIT_WATCHDOG_MS, resolveTimeoutMs } = require('../src/helpers/quitWatchdog');

function createFakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    timerRef(fn, delay) {
      const handle = { fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
      scheduled.push(handle);
      return handle;
    },
    clearRef(handle) {
      cleared.push(handle);
    },
  };
}

test('退出卡住时看门狗到点强制 app.exit(0)', () => {
  const timers = createFakeTimers();
  const exits = [];
  const warnings = [];
  const watchdog = createQuitWatchdog({
    app: { exit: (code) => exits.push(code) },
    logger: { warn: (message, data) => warnings.push({ message, data }) },
    timeoutMs: 1500,
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
  });

  const timer = watchdog.arm();
  assert.equal(watchdog.isArmed(), true);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timer.delay, 1500);
  assert.equal(timer.unrefCalled, true, '定时器必须 unref，避免反过来拖住退出');
  assert.deepEqual(exits, [], '未到点前不应强制退出');

  timer.fn();
  assert.deepEqual(exits, [0]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /强制结束进程/);
  assert.deepEqual(warnings[0].data, { timeoutMs: 1500 });
});

test('重复 arm 只装一个看门狗', () => {
  const timers = createFakeTimers();
  const exits = [];
  const watchdog = createQuitWatchdog({
    app: { exit: (code) => exits.push(code) },
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
  });

  const first = watchdog.arm();
  const second = watchdog.arm();
  assert.equal(first, second);
  assert.equal(timers.scheduled.length, 1);
  assert.deepEqual(exits, []);

  first.fn();
  assert.deepEqual(exits, [0], '即便重复 arm 也只应强制退出一次');
  assert.equal(timers.scheduled.length, 1);
});

test('disarm 会取消已装的看门狗', () => {
  const timers = createFakeTimers();
  const watchdog = createQuitWatchdog({
    app: { exit() {} },
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
  });

  const timer = watchdog.arm();
  assert.equal(watchdog.disarm(), true);
  assert.deepEqual(timers.cleared, [timer]);
  assert.equal(watchdog.isArmed(), false);
  assert.equal(watchdog.disarm(), false, '重复 disarm 不应再取消');
});

test('缺少 app.exit 时不装看门狗也不排定定时器', () => {
  const watchdog = createQuitWatchdog({
    app: {},
    timerRef: () => { throw new Error('不应排定定时器'); },
  });
  assert.equal(watchdog.arm(), null);
  assert.equal(watchdog.isArmed(), false);
  assert.equal(createQuitWatchdog().arm(), null);
});

test('看门狗预算：显式值优先，其次环境变量，非法值回退默认', () => {
  assert.equal(resolveTimeoutMs(2500, {}), 2500);
  assert.equal(resolveTimeoutMs(undefined, { CAPSWRITER_QUIT_WATCHDOG_MS: '1200' }), 1200);
  assert.equal(resolveTimeoutMs(undefined, {}), DEFAULT_QUIT_WATCHDOG_MS);
  assert.equal(resolveTimeoutMs(undefined, { CAPSWRITER_QUIT_WATCHDOG_MS: 'abc' }), DEFAULT_QUIT_WATCHDOG_MS);
  assert.equal(resolveTimeoutMs(undefined, { CAPSWRITER_QUIT_WATCHDOG_MS: '0' }), DEFAULT_QUIT_WATCHDOG_MS);
  assert.equal(resolveTimeoutMs(-1, { CAPSWRITER_QUIT_WATCHDOG_MS: '900' }), 900);
});
