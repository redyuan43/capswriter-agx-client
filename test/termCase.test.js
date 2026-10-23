const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeTermCase } = require('../src/helpers/protectedText');
const { TextPolisher } = require('../src/platform/electron/textPolish');

test('任意词表标准名统一大小写，不依赖别名或专名分支', () => {
  const entries = [{ term: 'WorkBuddy', weight: 100 }, { term: 'Tailscale', weight: 100 }, { term: 'NovaDesk', weight: 100 }];
  const result = normalizeTermCase('Workbuddy和workbuddy、TAILSCALE，以及novadesk。', entries);
  assert.equal(result.text, 'WorkBuddy和WorkBuddy、Tailscale，以及NovaDesk。');
  assert.equal(result.matches.length, 4);
  assert.equal(normalizeTermCase('work body、沃克巴蒂、worker、body、8', entries).text, 'work body、沃克巴蒂、worker、body、8');
});

test('大小写归一保护代码、路径、网址、标识符、停用词与词边界', () => {
  const entries = [{ term: 'WorkBuddy', weight: 100 }, { term: 'Tailscale', weight: 100, enabled: false }];
  const text = '`workbuddy` /tmp/workbuddy https://workbuddy.test workbuddy_id myworkbuddy workbuddy2 workBuddy tailscale';
  assert.equal(normalizeTermCase(text, entries).text, text);
  assert.equal(normalizeTermCase('排除workbuddy；使用workbuddy', [{ term: 'WorkBuddy', weight: 100, exclusions: ['排除'] }]).text, '排除workbuddy；使用workbuddy');
  for (const code of ['git status', 'ssh nx6', 'npm install', 'workbuddy()', 'const workbuddy = 1;', 'workbuddy --version', 'workbuddy | cat', 'workbuddy > output', 'workbuddy &']) {
    assert.equal(normalizeTermCase(code, [...entries, { term: 'Git' }, { term: 'SSH' }, { term: 'NPM' }]).text, code);
  }
});

test('按原文偏移应用不同长度的标准名，正则特殊字符不成为表达式', () => {
  const entries = [{ term: 'C++', weight: 100 }, { term: 'Tool(X)', weight: 100 }];
  assert.equal(normalizeTermCase('c++和tool(x)，toolx', entries).text, 'C++和Tool(X)，toolx');
  assert.equal(normalizeTermCase('c++compiler tool(x)Value', entries).text, 'c++compiler tool(x)Value');
});

test('完整整理流程沿用录音词表，保留原文并跳过终端大小写转换', async t => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-term-case-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDirectory, 'hot-rule.txt'), '');
  const polisher = new TextPolisher({ dataDirectory, hotWordsStore: {
    snapshot: () => ({ version: 'current' }),
    entriesForVersion: version => version === 'recording'
      ? [{ term: 'NovaDesk', weight: 100 }]
      : [{ term: 'NOVADESK', weight: 100 }],
  } });
  t.after(() => polisher.dispose());
  const raw = '请打开novadesk';
  const options = { dictionaryVersion: 'recording', skipModel: true, longFormat: { isTerminal: false } };
  const result = await polisher.polish(raw, options);
  assert.equal(result.raw_text, raw);
  assert.equal(result.corrected_text, '请打开NovaDesk');
  assert.equal(result.final_text, '请打开NovaDesk');
  assert.equal(result.dictionary_version, 'recording');

  const terminal = await polisher.polish('novadesk status', { ...options, longFormat: { isTerminal: true } });
  assert.equal(terminal.final_text, 'novadesk status');
  assert.equal((await polisher.polish(raw, { ...options, hotRule: false })).final_text, raw);
});
