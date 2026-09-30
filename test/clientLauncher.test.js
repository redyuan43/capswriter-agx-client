const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const INSTALLER = path.join(repoRoot, 'scripts/install-linux-client.sh');
const DEPLOYER = path.join(repoRoot, 'scripts/deploy-nx6-appimage.sh');
const FAKE_APPIMAGE = '/opt/caps/CapsWriter-GUI.AppImage';

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `caps-launcher-${label}-`));
}

/**
 * 把安装脚本里「生成启动器」的那一段原样抽出来执行，拿到与真实安装完全一致的启动器文件。
 * 这段只有 printf/chmod，没有网络与副作用，因此可以安全地离线跑。
 */
function renderInstallerLauncher(dir) {
  const script = fs.readFileSync(INSTALLER, 'utf8');
  const start = script.indexOf('LAUNCHER_PATH="${BIN_DIR}/capswriter-agx-client"');
  const chmodAt = script.indexOf('chmod 0755 "$LAUNCHER_PATH"', start);
  assert.ok(start > 0 && chmodAt > start, '安装脚本里没找到启动器生成段');
  const block = script.slice(start, chmodAt);
  execFileSync('bash', ['-c', `set -e\nBIN_DIR=${dir}\nAPPIMAGE_PATH=${FAKE_APPIMAGE}\n${block}`], {
    cwd: repoRoot,
  });
  const launcher = path.join(dir, 'capswriter-agx-client');
  assert.ok(fs.existsSync(launcher), '启动器未生成');
  return launcher;
}

function makeStubAppImage() {
  const dir = tmpdir('stub');
  const stub = path.join(dir, 'fake-appimage');
  const log = path.join(dir, 'started.log');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "started:$*" >> "${log}"\n`, { mode: 0o755 });
  return { stub, log };
}

function runLauncher(launcher, { cacheDir, stub, extraEnv = {} }) {
  const env = {
    ...process.env,
    HOME: path.dirname(cacheDir),
    // 启动器的 LOG_DIR / QUIT_MARKER 都落在 ${XDG_CACHE_HOME}/capswriter-agx-client
    XDG_CACHE_HOME: cacheDir,
    APPIMAGE_PATH: stub,
  };
  // 关键：INVOCATION_ID 是「由 systemd 拉起」的判据，而 CI runner 自身就跑在 systemd 会话里，
  // 会把该变量带进进程环境。测试必须显式控制它，否则「手动启动」用例会被误判成服务拉起。
  delete env.INVOCATION_ID;
  Object.assign(env, extraEnv);
  return execFileSync('bash', [launcher], { encoding: 'utf8', env, stdio: 'pipe' });
}

/** 把启动器里的 APPIMAGE_PATH 换成本地桩，便于观察「是否真的启动」。 */
function patchAppImage(launcher, stub) {
  const text = fs.readFileSync(launcher, 'utf8').replace(/^APPIMAGE_PATH=.*$/m, `APPIMAGE_PATH="${stub}"`);
  fs.writeFileSync(launcher, text, { mode: 0o755 });
}

function markerPath(cacheRoot) {
  return path.join(cacheRoot, 'capswriter-agx-client', 'intentional-quit');
}

test('生成的启动器语法正确，且带上去重 / 只拦服务拉起 / 跳过在用目录', () => {
  const dir = tmpdir('shape');
  const launcher = renderInstallerLauncher(dir);
  execFileSync('bash', ['-n', launcher]);
  const text = fs.readFileSync(launcher, 'utf8');

  // 解包运行下去重不能只看 cmdline，必须用 APPIMAGE 环境变量兜一层。
  // 注意 /proc/<pid>/environ 是 NUL 分隔的，必须 tr 后再 grep -x（带 ^ 锚点的 grep 永远匹配不到）。
  assert.match(text, /\/proc\/\$pid\/environ/);
  assert.match(text, /tr "\\0" "\\n" < "\/proc\/\$pid\/environ" 2>\/dev\/null \| grep -qx "APPIMAGE=\$APPIMAGE_PATH"/);
  assert.match(text, /appimage_extracted_/);
  // 30 秒窗口只拦 systemd 的自动拉起（INVOCATION_ID），手动启动照常
  assert.match(text, /INVOCATION_ID/);
  // 清理解包目录前必须跳过「有进程在用」的目录
  assert.match(text, /pgrep -u "\$\(id -u\)" -f "\$dir" >\/dev\/null 2>&1 && continue/);
  // 旧写法：无条件删掉所有 AppImage 的解包目录（会误删别人的活目录）
  assert.doesNotMatch(text, /rm -rf "\$\{TMPDIR:-\/tmp\}"/);

  const deployText = fs.readFileSync(DEPLOYER, 'utf8');
  for (const pattern of [
    /\/proc\/\$pid\/environ/,
    /grep -qx "APPIMAGE=\$APPIMAGE_PATH"/,
    /INVOCATION_ID/,
    /&& continue/,
  ]) {
    assert.match(deployText, pattern, `部署脚本的启动器缺少 ${pattern}`);
  }
  assert.doesNotMatch(
    deployText,
    /printf '%s\\n' 'rm -rf "\$\{TMPDIR:-\/tmp\}"/,
    '部署脚本仍在无条件清理所有解包目录'
  );
});

test('服务拉起 + 刚退出：拒绝启动并留日志；手动启动照常', () => {
  const dir = tmpdir('marker');
  const cacheRoot = path.join(dir, 'cache');
  const launcher = renderInstallerLauncher(dir);
  const { stub, log } = makeStubAppImage();
  patchAppImage(launcher, stub);

  fs.mkdirSync(path.join(cacheRoot, 'capswriter-agx-client'), { recursive: true });
  const marker = markerPath(cacheRoot);
  fs.writeFileSync(marker, '2026-09-30T00:00:00.000Z\n');
  const launcherLog = path.join(cacheRoot, 'capswriter-agx-client', 'capswriter-agx-client.log');

  // 1) systemd 拉起（有 INVOCATION_ID）→ 不启动
  runLauncher(launcher, { cacheDir: cacheRoot, stub, extraEnv: { INVOCATION_ID: 'abc123' } });
  assert.equal(fs.existsSync(log), false, '服务拉起被拒绝时不应启动应用');
  assert.match(fs.readFileSync(launcherLog, 'utf8'), /跳过本次自动拉起/);
  assert.ok(fs.existsSync(marker), '拒绝启动时不应消费掉标记');

  // 2) 用户手动启动（无 INVOCATION_ID）→ 必须能起来，不能出现「点了没反应」
  runLauncher(launcher, { cacheDir: cacheRoot, stub, extraEnv: {} });
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'started:--no-sandbox');
});

test('过期标记会被清掉并放行启动', () => {
  const dir = tmpdir('stale');
  const cacheRoot = path.join(dir, 'cache');
  const launcher = renderInstallerLauncher(dir);
  const { stub, log } = makeStubAppImage();
  patchAppImage(launcher, stub);

  fs.mkdirSync(path.join(cacheRoot, 'capswriter-agx-client'), { recursive: true });
  const marker = markerPath(cacheRoot);
  fs.writeFileSync(marker, 'old\n');
  const ancient = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(marker, ancient, ancient);

  runLauncher(launcher, { cacheDir: cacheRoot, stub, extraEnv: { INVOCATION_ID: 'abc123' } });
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'started:--no-sandbox');
  assert.equal(fs.existsSync(marker), false, '过期标记应被清掉');
});

test(
  '解包运行中的同一实例会被识别，不会重复启动',
  { skip: process.platform !== 'linux' ? '仅 Linux 有 /proc' : false },
  () => {
    const dir = tmpdir('dedupe');
    const cacheRoot = path.join(dir, 'cache');
    const launcher = renderInstallerLauncher(dir);
    const { stub, log } = makeStubAppImage();
    patchAppImage(launcher, stub);

    // 造一个「extract-and-run 形态」的同实例：cmdline 指向 /tmp/appimage_extracted_*/，环境里带 APPIMAGE
    const fake = spawn(
      'bash',
      ['-c', `exec -a /tmp/appimage_extracted_deadbeef/AppRun sleep 30`],
      {
        env: { ...process.env, APPIMAGE: stub },
        stdio: 'ignore',
        detached: true,
      }
    );
    try {
      const deadline = Date.now() + 5000;
      // 等 pgrep 能稳定看到它（没命中时 pgrep 退出码为 1，不能直接 execFileSync）
      let visible = false;
      while (Date.now() < deadline) {
        const probe = spawnSync('pgrep', ['-u', String(process.getuid()), '-f', 'appimage_extracted_'], {
          encoding: 'utf8',
        });
        if (probe.status === 0 && probe.stdout.trim()) {
          visible = true;
          break;
        }
      }
      assert.ok(visible, '未造出「解包运行中的实例」，去重无法验证');

      runLauncher(launcher, { cacheDir: cacheRoot, stub, extraEnv: {} });
      assert.equal(fs.existsSync(log), false, '已有解包运行的实例时不应再启动第二个');
    } finally {
      try {
        process.kill(-fake.pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }
  }
);
