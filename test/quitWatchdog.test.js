const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createQuitWatchdog,
  DEFAULT_QUIT_WATCHDOG_MS,
  resolveTimeoutMs,
  resolveGracefulMs,
  readProcessStartTime,
  buildKillerScript,
  resolveQuitMarkerPath,
  markIntentionalQuit,
  QUIT_MARKER_FILE_NAME,
} = require('../src/helpers/quitWatchdog');

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

function createFakeSpawn() {
  const calls = [];
  const spawnRef = (command, args, options) => {
    const child = { command, args, options, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
    calls.push(child);
    return child;
  };
  return { calls, spawnRef };
}

/**
 * 构造 /proc/<pid>/stat 的一行：第 1 个字段是 pid，第 2 个是 (comm)，第 22 个是 starttime。
 * 去掉 "pid (comm)" 后还剩 21 个字段，索引 19 即 starttime。
 */
function statLine(pid, comm, startTime) {
  const remaining = [
    'S', 1, 2, 3, 4, 5,
    ...Array.from({ length: 10 }, () => 0),
    20, 0, 1, startTime, 0,
  ];
  assert.equal(remaining.length, 21);
  return `${pid} (${comm}) ${remaining.join(' ')}`;
}

function createLogger() {
  const messages = { info: [], warn: [] };
  return {
    messages,
    logger: {
      info: (message, data) => messages.info.push({ message, data }),
      warn: (message, data) => messages.warn.push({ message, data }),
    },
  };
}

test('退出卡住时：先到点尝试 app.exit(0)，外部杀手在宽限后 SIGKILL', () => {
  const timers = createFakeTimers();
  const spawner = createFakeSpawn();
  const { messages, logger } = createLogger();
  const exits = [];
  const watchdog = createQuitWatchdog({
    app: { exit: (code) => exits.push(code) },
    logger,
    timeoutMs: 6000,
    env: {},
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
    spawnRef: spawner.spawnRef,
    platform: 'linux',
    pid: 4242,
    fsRef: { readFileSync: () => statLine(4242, 'CapsWriter-GUI', 123456) },
  });

  const timer = watchdog.arm();
  assert.equal(watchdog.isArmed(), true);
  // 进程内只做「早一步的优雅尝试」：总宽限 6000ms 时它在 5000ms 触发
  assert.equal(timer.delay, 5000);
  assert.equal(timer.unrefCalled, true, '定时器必须 unref，避免反过来拖住退出');

  assert.equal(spawner.calls.length, 1, '必须派出一个脱离会话的外部杀手');
  const child = spawner.calls[0];
  assert.equal(child.command, '/bin/sh');
  assert.equal(child.options.detached, true);
  assert.equal(child.options.stdio, 'ignore');
  assert.equal(child.unrefCalled, true);
  const script = child.args[1];
  assert.match(script, /^sleep 6$/m);
  assert.match(script, /^pid=4242$/m);
  assert.match(script, /expected='123456'/);
  assert.match(script, /cut -d' ' -f20/);
  assert.match(script, /kill -9 "\$pid"/);
  assert.equal(messages.info.length, 1);
  assert.match(messages.info[0].message, /外部杀手/);

  assert.deepEqual(exits, [], '未到点前不应强制退出');
  timer.fn();
  assert.deepEqual(exits, [0]);
  assert.equal(messages.warn.length, 1);
  assert.match(messages.warn[0].message, /强制结束进程/);
});

test('重复 arm 只装一套看门狗', () => {
  const timers = createFakeTimers();
  const spawner = createFakeSpawn();
  const exits = [];
  const watchdog = createQuitWatchdog({
    app: { exit: (code) => exits.push(code) },
    env: {},
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
    spawnRef: spawner.spawnRef,
    platform: 'linux',
    pid: 1,
    fsRef: { readFileSync: () => statLine(1, 'x', 999) },
  });

  const first = watchdog.arm();
  const second = watchdog.arm();
  assert.equal(first, second);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(spawner.calls.length, 1);
  first.fn();
  assert.deepEqual(exits, [0], '即便重复 arm 也只应强制退出一次');
});

test('非 linux 平台或显式关闭时不派外部杀手', () => {
  const spawner = createFakeSpawn();
  const timers = createFakeTimers();
  const base = {
    app: { exit() {} },
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
    spawnRef: spawner.spawnRef,
    pid: 7,
    fsRef: { readFileSync: () => '' },
  };

  createQuitWatchdog({ ...base, env: {}, platform: 'darwin' }).arm();
  assert.equal(spawner.calls.length, 0, 'darwin 不派 /bin/sh 杀手');

  createQuitWatchdog({ ...base, env: { CAPSWRITER_QUIT_HARD_KILL: '0' }, platform: 'linux' }).arm();
  assert.equal(spawner.calls.length, 0, 'CAPSWRITER_QUIT_HARD_KILL=0 时只保留进程内看门狗');

  createQuitWatchdog({ ...base, env: { NODE_TEST_CONTEXT: 'child-v8' }, platform: 'linux' }).arm();
  assert.equal(spawner.calls.length, 0, '测试环境下不真的派杀手，避免误杀测试进程');
});

test('杀不掉就撤：disarm 取消进程内定时器', () => {
  const timers = createFakeTimers();
  const spawner = createFakeSpawn();
  const watchdog = createQuitWatchdog({
    app: { exit() {} },
    env: {},
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
    spawnRef: spawner.spawnRef,
    platform: 'darwin',
  });

  const timer = watchdog.arm();
  assert.equal(watchdog.disarm(), true);
  assert.deepEqual(timers.cleared, [timer]);
  assert.equal(watchdog.isArmed(), false);
  assert.equal(watchdog.disarm(), false, '重复 disarm 不应再取消');
});

test('装载外部杀手失败时不影响退出流程', () => {
  const timers = createFakeTimers();
  const { messages, logger } = createLogger();
  const watchdog = createQuitWatchdog({
    app: { exit() {} },
    logger,
    env: {},
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
    spawnRef: () => { throw new Error('spawn 失败'); },
    platform: 'linux',
    pid: 9,
    fsRef: { readFileSync: () => '' },
  });

  assert.ok(watchdog.arm());
  const messages2 = messages.warn.map((entry) => entry.message).join('\n');
  // starttime 读不到会先告警一次，随后 spawn 失败再告警一次，两条都必须在
  assert.match(messages2, /starttime 字段缺失/);
  assert.match(messages2, /装载退出外部杀手失败/);
});

test('缺少 app.exit 时不装看门狗也不排定定时器', () => {
  const watchdog = createQuitWatchdog({
    app: {},
    env: {},
    timerRef: () => { throw new Error('不应排定定时器'); },
    spawnRef: () => { throw new Error('不应派杀手'); },
    platform: 'linux',
  });
  assert.equal(watchdog.arm(), null);
  assert.equal(watchdog.isArmed(), false);
  assert.equal(createQuitWatchdog().arm(), null);
});

test('主动退出标记写到启动器检查的同一路径，写失败只告警', () => {
  const dirs = [];
  const writes = [];
  const marker = markIntentionalQuit({
    env: { CAPSWRITER_QUIT_MARKER_DIR: '/tmp/quit-marker' },
    fsRef: {
      mkdirSync: (dir) => dirs.push(dir),
      writeFileSync: (file, content) => writes.push({ file, content }),
    },
    logger: { info() {}, warn() {} },
    now: () => new Date('2026-09-30T00:00:00Z'),
    platform: 'linux',
  });

  assert.equal(marker, '/tmp/quit-marker/intentional-quit');
  assert.deepEqual(dirs, ['/tmp/quit-marker']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, '/tmp/quit-marker/intentional-quit');
  assert.match(writes[0].content, /2026-09-30T00:00:00\.000Z/);

  // 默认位置与启动器里的 ${XDG_CACHE_HOME:-$HOME/.cache}/capswriter-agx-client 一致
  assert.equal(QUIT_MARKER_FILE_NAME, 'intentional-quit');
  assert.equal(
    resolveQuitMarkerPath({ XDG_CACHE_HOME: '/home/u/.cache' }),
    '/home/u/.cache/capswriter-agx-client/intentional-quit'
  );

  const warnings = [];
  assert.equal(
    markIntentionalQuit({
      env: {},
      fsRef: { mkdirSync() { throw new Error('EACCES'); } },
      logger: { warn: (message) => warnings.push(message) },
      platform: 'linux',
    }),
    null
  );
  assert.equal(warnings.length, 1);

  // 非 Linux 平台没有读取该标记的启动器，不写无用标记文件
  const writesOnMac = [];
  assert.equal(
    markIntentionalQuit({
      env: {},
      fsRef: {
        mkdirSync() {},
        writeFileSync: (...args) => writesOnMac.push(args),
      },
      platform: 'darwin',
    }),
    null
  );
  assert.equal(writesOnMac.length, 0);
});

test('启动器与 systemd 单元都带上了退出修复（防回退）', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../scripts/install-linux-client.sh'), 'utf8');
  assert.match(installer, /APPIMAGE_EXTRACT_AND_RUN/);
  assert.match(installer, /intentional-quit/);
  assert.match(installer, /Restart=on-abnormal/);

  const deploy = fs.readFileSync(path.join(__dirname, '../scripts/deploy-nx6-appimage.sh'), 'utf8');
  assert.match(deploy, /intentional-quit/);
  assert.match(deploy, /Restart=on-abnormal/);
});

test('宽限预算：显式值优先，其次环境变量，非法值回退默认', () => {
  assert.equal(resolveTimeoutMs(2500, {}), 2500);
  assert.equal(resolveTimeoutMs(undefined, { CAPSWRITER_QUIT_WATCHDOG_MS: '1200' }), 1200);
  assert.equal(resolveTimeoutMs(undefined, {}), DEFAULT_QUIT_WATCHDOG_MS);
  assert.equal(resolveTimeoutMs(undefined, { CAPSWRITER_QUIT_WATCHDOG_MS: 'abc' }), DEFAULT_QUIT_WATCHDOG_MS);
  assert.equal(resolveTimeoutMs(undefined, { CAPSWRITER_QUIT_WATCHDOG_MS: '0' }), DEFAULT_QUIT_WATCHDOG_MS);
  assert.equal(resolveTimeoutMs(-1, { CAPSWRITER_QUIT_WATCHDOG_MS: '900' }), 900);
  // 优雅尝试始终早于硬杀，且不早于 1 秒
  assert.equal(resolveGracefulMs(6000), 5000);
  assert.equal(resolveGracefulMs(1500), 1000);
  assert.equal(resolveGracefulMs(800), 1000);
});

test('starttime 解析与杀手脚本：只认同一进程，避免 pid 复用误杀', () => {
  const stat = statLine(1234, 'some proc', 987654);
  assert.equal(readProcessStartTime(1234, { readFileSync: () => stat }), '987654');
  assert.equal(readProcessStartTime(1, { readFileSync: () => { throw new Error('ENOENT'); } }), '');

  const script = buildKillerScript({ pid: 1234, startTime: '987654', graceSeconds: 6 });
  assert.match(script, /^sleep 6$/m);
  assert.match(script, /\[ -r "\/proc\/\$pid\/stat" \] \|\| exit 0/);
  // 身份校验必须「失败即放弃」：空值分支各自短路，不能因为 && 链短路而落到 kill
  assert.match(script, /\[ -n "\$expected" \] \|\| exit 0/);
  assert.match(script, /\[ -n "\$actual" \] \|\| exit 0/);
  assert.match(script, /\[ "\$actual" = "\$expected" \] \|\| exit 0/);
  assert.match(script, /kill -9 "\$pid" 2>\/dev\/null \|\| true$/m);
  // kill 必须排在三条校验之后，不能出现「校验失败反而继续执行 kill」的顺序
  assert.ok(script.indexOf('kill -9 "$pid"') > script.indexOf('[ -n "$actual" ] || exit 0'));
});

test('读不到 starttime 时必须留痕并放弃身份校验', () => {
  const { messages, logger } = createLogger();
  assert.equal(readProcessStartTime(1, { readFileSync: () => { throw new Error('ENOENT'); } }, logger), '');
  assert.equal(messages.warn.length, 1);
  assert.match(messages.warn[0].message, /读取 \/proc\/<pid>\/stat 失败/);

  const timers = createFakeTimers();
  const spawns = [];
  const watchdog = createQuitWatchdog({
    app: { exit() {} },
    logger,
    env: {},
    timerRef: timers.timerRef,
    clearRef: timers.clearRef,
    spawnRef: (cmd, args) => { spawns.push(args[1]); return { unref() {} }; },
    platform: 'linux',
    pid: 4242,
    fsRef: { readFileSync: () => { throw new Error('ENOENT'); } },
  });
  watchdog.arm();
  // 脚本里 expected 为空 → 到点不会杀，交给进程内定时器与 systemd 兜底
  assert.equal(spawns.length, 1);
  assert.match(spawns[0], /^expected=''$/m);
  assert.match(messages.warn.map((entry) => entry.message).join('\n'), /放弃身份校验/);
});
