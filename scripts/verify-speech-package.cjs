// 用构建产物的 Electron 运行：ELECTRON_RUN_AS_NODE=1 <binary> <script> <app.asar>
// 仅验证资源和内存数据库，不启动应用、快捷键或实际云端请求。
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

async function main() {
  assert.ok(process.versions.electron, '必须使用构建产物中的 Electron');
  const archive = path.resolve(process.argv[2]);
  const packed = createRequire(path.join(archive, 'package.json'));
  const { HotRuleReplacer } = packed('./src/helpers/hotRuleReplace');
  const rules = new HotRuleReplacer();
  rules.load('测试术语 = TestTerm');
  const normal = await rules.applyAsync('请用测试术语。');
  assert.equal(normal.error, null);
  assert.equal(normal.text, '请用TestTerm。');
  rules.load('(a+)+$ = x');
  const started = Date.now();
  const runaway = await rules.applyAsync(`${'a'.repeat(40)}!`, { timeoutMs: 200 });
  assert.equal(runaway.error, 'rule_timeout');
  assert.ok(Date.now() - started < 2000);

  const { SpeechTextFormatter, MODEL } = packed('./src/helpers/speechTextFormatter');
  assert.equal(MODEL, 'glm-4.7-flash');
  const formatter = new SpeechTextFormatter({ getApiKey: () => '' });
  assert.equal((await formatter.format('测试')).degraded, 'api_key_missing');
  const hashes = {};
  for (const [name, expected] of Object.entries({
    enhance_system_prompt: 'f8306b1918a322c0d6e3a646715a73210de2f8e5277243a7220bedf3ee89c1f9',
    enhance_user_prompt: '4c33e4c1339531140f07ab485ba0084462fa98bf39c1c41730a77b12dafc1549',
  })) {
    hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(archive, 'assets/prompts/workbuddy-5.5.6', `${name}.md`))).digest('hex');
    assert.equal(hashes[name], expected);
  }

  const { ffmpegExecutable } = packed('./src/helpers/ffmpegExecutable');
  const executable = ffmpegExecutable();
  assert.ok(executable.startsWith(`${archive}.unpacked`), '不得使用系统 ffmpeg 掩盖打包缺失');
  fs.accessSync(executable, fs.constants.X_OK);
  const conversion = spawnSync(executable, ['-v', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'], { input: Buffer.alloc(16000), timeout: 10000 });
  assert.equal(conversion.status, 0, conversion.error?.message || conversion.signal || conversion.stderr?.toString());
  assert.ok(conversion.stdout.length > 100);
  const Database = packed('better-sqlite3');
  const database = new Database(':memory:');
  assert.equal(database.prepare('select 1 as ok').get().ok, 1);
  database.close();
  assert.equal(typeof packed('uiohook-napi').uIOhook.start, 'function');
  const root = path.resolve(__dirname, '..');
  let sourceFiles = 0;
  const verifySource = (relative) => {
    if (relative === 'src/helpers/m5SerialDiagnose.js') {
      assert.equal(fs.existsSync(path.join(archive, relative)), false,
        '串口诊断工具必须保持在 AppImage 之外');
      return;
    }
    const source = path.join(root, relative);
    if (fs.statSync(source).isDirectory()) {
      for (const name of fs.readdirSync(source)) verifySource(path.join(relative, name));
    } else {
      assert.ok(fs.readFileSync(source).equals(fs.readFileSync(path.join(archive, relative))), `产物与当前源码不一致：${relative}`);
      sourceFiles++;
    }
  };
  for (const relative of ['main.js', 'preload.js', 'src/helpers', 'src/platform', 'src/utils', 'src/dist', 'assets']) verifySource(relative);
  const report = { electron: process.versions.electron, arch: process.arch, regexChild: true,
    regexDeadline: true, freeModel: MODEL, promptHashes: hashes, packagedFfmpeg: true,
    nativeSqlite: true, nativeUiohook: true, sourceFilesMatched: sourceFiles };
  const target = path.join(__dirname, '../artifacts/asr-review/package-check.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
