const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { SpeechTextFormatter, validateLight, validateEnhancement } = require('../src/helpers/speechTextFormatter');

test('FireRed2 整理只访问本机，切回腾讯仍固定免费 GLM', async () => {
  let active = 'firered2-local', keyReads = 0;
  const calls = [];
  const formatter = new SpeechTextFormatter({ getAsrProfileId: () => active,
    getApiKey: () => { keyReads++; return 'cloud-secret'; },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '你好。' } }] }) };
    },
  });
  assert.equal((await formatter.format('你好')).provider, 'local');
  assert.equal(keyReads, 0);
  assert.equal(calls[0].url, 'http://127.0.0.1:18087/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].body.model, 'capswriter-qwen3-4b');
  assert.equal(calls[0].body.chat_template_kwargs.enable_thinking, false);
  assert.equal(calls[0].body.reasoning_budget, 0);
  active = 'tencent-direct';
  assert.equal((await formatter.format('你好', { asrProvider: 'firered2' })).provider, 'local');
  assert.equal(keyReads, 0);
  assert.equal((await formatter.format('你好', { asrProvider: 'tencent' })).provider, 'glm');
  assert.equal(calls.at(-1).body.model, 'glm-4.7-flash');
  assert.equal(calls.at(-1).body.thinking.type, 'disabled');
});

test('本机模型失败不读取云端密钥、不向云端回退', async () => {
  const urls = [];
  const formatter = new SpeechTextFormatter({ getAsrProfileId: () => 'firered2-local',
    getApiKey: () => { throw new Error('不得读取云端密钥'); },
    fetchImpl: async url => { urls.push(url); throw new Error('offline'); },
  });
  const result = await formatter.format('保留这段原文。');
  assert.equal(result.text, '保留这段原文。');
  assert.equal(result.degraded, 'request_failed');
  assert.deepEqual(urls, ['http://127.0.0.1:18087/v1/chat/completions']);
  assert.equal(formatter.getTimeoutMs('light'), 15000);
  assert.equal(formatter.getTimeoutMs('prompt'), 60000);
});
const { protectedSpans, segmentWithOffsets, applyAliases } = require('../src/helpers/protectedText');
const { HotRuleReplacer } = require('../src/helpers/hotRuleReplace');
const { HotWordsStore } = require('../src/platform/electron/hotWordsStore');
const { ProviderSecrets } = require('../src/helpers/providerSecrets');
const { TextPolisher } = require('../src/platform/electron/textPolish');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-speech-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function mockReply(content, finish = 'stop') {
  return { ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }) };
}

for (const [name, original, output] of [
  ['否定词', '请不要删除旧配置，检查日志之后再运行。', '请要删除旧配置，检查日志之后再运行。'],
  ['小数', '超时设为 1.23 秒。', '超时设为 12.3 秒。'],
  ['负号', '超时设为 -1 秒。', '超时设为 1 秒。'],
  ['单位', '缓存设置为 10 MB。', '缓存设置为 10 GB。'],
  ['URL', '访问 https://example.com/千问/README.md。', '访问 https://example.com/Qwen/README.md。'],
  ['代码', '调用 `foo_bar(-1)`。', '调用 `foo_bar(1)`。'],
  ['运算符', '表达式 a+b。', '表达式 ab。'],
  ['英文否定缩写', "Don't remove this file.", 'Dont remove this file.'],
  ['命令参数', '运行 --no-sandbox。', '运行 no-sandbox。'],
  ['单向删除', '先检查运行日志，确认连接正常，保存备份，然后再执行升级。', '先检查运行日志，确认连接正常，然后再执行升级。'],
]) test(`轻度润色拒绝改变${name}`, () => assert.equal(validateLight(original, output).ok, false));

test('轻度润色允许修复错误断句和分段', () => {
  assert.equal(validateLight('请检查日志和。接线是否正确，然后再运行测试。', '请检查日志和接线是否正确，然后再运行测试。').ok, true);
});

test('提示词优化使用独立校验，可以改写，保留参数', () => {
  assert.equal(validateEnhancement('请检查超时 -1，别换 GLM-4.7-Flash。', '请检查超时参数 -1 的处理逻辑，保留 GLM-4.7-Flash 模型配置，并说明修复结果。').ok, true);
  assert.equal(validateEnhancement('超时 -1', '超时 1').ok, false);
  assert.equal(validateEnhancement('检查代码', 'Here is the explanation.').ok, false);
});

test('分词保留所有原文偏移及空格', () => {
  const text = '使用 API foo_bar，保持 1.23。';
  const parts = segmentWithOffsets(text);
  assert.equal(parts.map((p) => text.slice(p.start, p.end)).join(''), text);
  assert.ok(protectedSpans(text).some((s) => s.text === 'foo_bar'));
});

test('别名按原文最长匹配，不级联、不改 URL，有排除上下文', () => {
  const entries = [
    { term: 'Qwen', aliases: ['千问'], exclusions: ['景点'] },
    { term: 'Other', aliases: ['Qwen'] },
    { term: 'Qwen3', aliases: ['千问三'] },
  ];
  assert.equal(applyAliases('用千问三和千问', entries).text, '用Qwen3和Qwen');
  assert.equal(applyAliases('景点千问 https://x.test/千问', entries).text, '景点千问 https://x.test/千问');
});

test('正则规则保护枚举、正常地名、数字及路径；只替换原文匹配', () => {
  const r = new HotRuleReplacer();
  r.load('二、 = 二\n负一 = -1\n紫禁城 = 子进程\n千问 = Qwen\nQwen = Other');
  const original = '第二、去紫禁城，负一点二，用千问，打开 https://x.test/千问';
  assert.equal(r.apply(original).text, original.replace('用千问', '用Qwen'));
});

test('灾难性回溯在子进程超时后终止，不阻塞主进程', async () => {
  const r = new HotRuleReplacer(); r.load('(a+)+$ = b');
  const text = 'a'.repeat(100) + '!';
  const start = Date.now();
  const result = await r.applyAsync(text, { timeoutMs: 100 });
  assert.equal(result.error, 'rule_timeout'); assert.equal(result.text, text);
  assert.ok(Date.now() - start < 1000);
});

test('词库超过 128 不丢失，单次请求限制 128，保留旧文件', (t) => {
  const dir = temp(t), legacy = path.join(dir, 'hot-words.txt');
  const original = '# 用户注释\n旧词|7\n'; fs.writeFileSync(legacy, original);
  const store = new HotWordsStore({ dataDirectory: dir });
  const result = store.add(Array.from({ length: 200 }, (_, i) => `Term${i}`));
  assert.equal(result.added, 200); assert.equal(store.entries.length, 201);
  const snapshot = store.snapshot(); assert.equal(snapshot.selected, 128); assert.equal(snapshot.omitted, 73);
  assert.equal(snapshot.entries.find((e) => e.term === 'Term0').weight, 5);
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
  assert.equal(new HotWordsStore({ dataDirectory: dir }).entries.length, 201);
});

test('词库校验、停用、别名、候选确认、快照与热重载', (t) => {
  const dir = temp(t), legacy = path.join(dir, 'hot-words.txt'); fs.writeFileSync(legacy, '原词|4\n');
  const store = new HotWordsStore({ dataDirectory: dir });
  const result = store.add(['带 空格', '坏,词', '坏|词', '一二三四五六七八九十十一', 'a'.repeat(31)]);
  assert.equal(result.added, 0); assert.equal(result.rejected.length, 5);
  store.propose(['候选', '带 空格']); assert.deepEqual(store.candidates, ['候选']);
  assert.equal(store.snapshot().hotword.includes('候选'), false);
  store.update({ term: '候选', aliases: ['侯选'], exclusions: ['投票'], weight: 8 });
  assert.equal(store.candidates.length, 0);
  const before = store.snapshot();
  store.update({ term: '候选', enabled: false });
  assert.ok(store.entriesForVersion(before.version).some((s) => s.term === '候选' && s.enabled));
  assert.equal(store.snapshot().hotword.includes('候选'), false);
  fs.appendFileSync(legacy, '磁盘新词|6\n');
  assert.match(store.snapshot().hotword, /磁盘新词\|6/);
});

test('词库原子保存失败时不谎报成功、不改变内存', (t) => {
  const dir = temp(t); fs.writeFileSync(path.join(dir, 'hot-words.txt'), '原词|5');
  const store = new HotWordsStore({ dataDirectory: dir, fsImpl: { ...fs, renameSync() { throw new Error('disk failed'); } } });
  assert.equal(store.add(['新词']).added, 0); assert.deepEqual(store.list(), ['原词']);
});

test('旧词表追加后保留 GUI 权重、别名及禁用状态', (t) => {
  const dir = temp(t), legacy = path.join(dir, 'hot-words.txt');
  fs.writeFileSync(legacy, '原词|11\n未编辑|4\n');
  const store = new HotWordsStore({ dataDirectory: dir });
  store.update({ term: '原词', weight: 3, aliases: ['元词'], enabled: false });
  fs.writeFileSync(legacy, '原词|11\n未编辑|6\n新增|5\n');
  const restored = new HotWordsStore({ dataDirectory: dir });
  const entry = restored.entries.find(row => row.term === '原词');
  assert.equal(entry.weight, 3);
  assert.equal(entry.enabled, false);
  assert.deepEqual(entry.aliases, ['元词']);
  assert.equal(restored.entries.find(row => row.term === '未编辑').weight, 6);
  assert.ok(restored.list().includes('新增'));
});

test('WorkBuddy 模板字节和上游固定版本一致', () => {
  for (const [name, digest] of [
    ['enhance_system_prompt.md', 'f8306b1918a322c0d6e3a646715a73210de2f8e5277243a7220bedf3ee89c1f9'],
    ['enhance_user_prompt.md', '4c33e4c1339531140f07ab485ba0084462fa98bf39c1c41730a77b12dafc1549'],
  ]) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../assets/prompts/workbuddy-5.5.6', name))).digest('hex'), digest);
});

test('两种模式强制免费 GLM、关闭思考，输入中的美元符号保持字面值', async () => {
  const bodies = [];
  const formatter = new SpeechTextFormatter({ getApiKey: () => 'fake-test-key', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return mockReply('检查配置。');
  } });
  await formatter.format('检查配置。', { mode: 'light' });
  await formatter.format('检查 $& 和 $1 的含义。', { mode: 'prompt' });
  for (const body of bodies) { assert.equal(body.model, 'glm-4.7-flash'); assert.deepEqual(body.thinking, { type: 'disabled' }); }
  assert.ok(bodies[1].messages[1].content.includes('检查 $& 和 $1 的含义。'));
  assert.notEqual(bodies[0].messages[0].content, bodies[1].messages[0].content);
});

test('已收到 headers 但 body 卡住，仍在截止时间回退', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"choices":['); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const f = new SpeechTextFormatter({ getApiKey: () => 'fake', endpoint: `http://127.0.0.1:${server.address().port}` });
  const result = await f.format('原文不能丢。', { timeoutMs: 120 });
  assert.equal(result.text, '原文不能丢。'); assert.equal(result.degraded, 'timeout'); assert.ok(result.elapsed_ms < 700);
});

test('取消忽略迟到结果，截断和思考输出不能进入正文', async () => {
  const controller = new AbortController();
  const f = new SpeechTextFormatter({ getApiKey: () => 'fake', fetchImpl: async () => {
    await new Promise((r) => setTimeout(r, 100)); return mockReply('迟到结果');
  } });
  const pending = f.format('原文', { signal: controller.signal }); controller.abort();
  assert.equal((await pending).degraded, 'cancelled');
  for (const reply of [mockReply('被截断', 'length'), mockReply('<think>思考</think>正文'), mockReply('')]) {
    const result = await new SpeechTextFormatter({ getApiKey: () => 'fake', fetchImpl: async () => reply }).format('原文');
    assert.equal(result.text, '原文'); assert.ok(result.degraded);
  }
});

test('加密凭据只返回配置状态，拒绝 basic_text', (t) => {
  const dir = temp(t);
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test_secure',
    encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const store = new ProviderSecrets({ dataDirectory: dir, safeStorage, env: {} });
  const status = store.save({ glmApiKey: 'fake-private-value' });
  assert.equal(status.configured.glmApiKey, true);
  assert.equal(JSON.stringify(status).includes('fake-private-value'), false);
  assert.equal(fs.readFileSync(store.filePath, 'utf8').includes('fake-private-value'), false);
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  safeStorage.getSelectedStorageBackend = () => 'basic_text';
  assert.throws(() => store.save({ glmApiKey: 'other' }), /拒绝明文/);
});

test('编排记录原始、纠正、最终结果，服务失败仍保留列举格式', async (t) => {
  const p = new TextPolisher({ dataDirectory: temp(t), longFormatter: { format: async (text) => ({ text, degraded: 'http_429', model: 'glm-4.7-flash' }) } });
  const raw = '第一、保留原文。第二、检查结果。';
  const result = await p.polish(raw, { hotRule: false, longFormat: { isTerminal: true } });
  assert.equal(result.raw_text, raw); assert.equal(result.corrected_text, raw);
  assert.match(result.final_text, /\n/); assert.equal(result.copyOnly, true); assert.equal(result.degraded, 'http_429');
});
