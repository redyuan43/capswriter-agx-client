const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HotWordsStore, parseHotWords, normalizeEntry, MAX_TERMS } = require('../src/platform/electron/hotWordsStore');

function createStore(t, text = '') {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-hotword-weight-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDirectory, 'hot-words.txt'), text);
  return { dataDirectory, store: new HotWordsStore({ dataDirectory }) };
}

test('文本和 JSON 接受 1–11 及显式 100，其他权重继续回落到默认值', () => {
  for (const weight of [1, 5, 11, 100]) {
    assert.equal(parseHotWords(`NovaCanvas|${weight}`)[0].weight, weight);
    assert.equal(normalizeEntry({ term: 'NovaCanvas', weight }).weight, weight);
    assert.equal(normalizeEntry({ term: 'NovaCanvas', weight: String(weight) }).weight, weight);
  }
  for (const weight of [0, 12, 99, 101, -1, 1.5, 100.5, NaN, Infinity]) {
    assert.equal(parseHotWords(`NovaCanvas|${weight}`)[0].weight, 5);
    assert.equal(normalizeEntry({ term: 'NovaCanvas', weight }).weight, 5);
  }
});

test('显式 100 经过保存和托管权重仍原样上送，普通及强热词维持 5/11', t => {
  const { dataDirectory, store } = createStore(t, 'NovaCanvas|100\nPlainTerm|8\nStrongTerm|7\n');
  store.update({ term: 'StrongTerm', weight: 7, strong: true });
  const managed = store.configure({ managedWeights: true });
  assert.deepEqual(Object.fromEntries(managed.entries.map(entry => [entry.term, entry.weight])), {
    StrongTerm: 11, NovaCanvas: 100, PlainTerm: 5,
  });
  assert.ok(managed.hotword.split(',').includes('NovaCanvas|100'));
  assert.equal(store.entriesForVersion(managed.version).find(entry => entry.term === 'PlainTerm').weight, 8);

  const reloaded = new HotWordsStore({ dataDirectory });
  assert.ok(reloaded.snapshot().hotword.split(',').includes('NovaCanvas|100'));
  const unmanaged = reloaded.configure({ managedWeights: false });
  assert.deepEqual(Object.fromEntries(unmanaged.entries.map(entry => [entry.term, entry.weight])), {
    StrongTerm: 7, NovaCanvas: 100, PlainTerm: 8,
  });
});

test('新增与编辑可以显式选用或撤销 100，不自动升级普通强热词', t => {
  const { dataDirectory, store } = createStore(t);
  assert.equal(store.add(['QueryForge'], { weight: 100 }).added, 1);
  store.configure({ managedWeights: true });
  assert.equal(store.snapshot().hotword, 'QueryForge|100');
  store.update({ term: 'QueryForge', weight: 5, strong: true });
  assert.equal(store.snapshot().hotword, 'QueryForge|11');
  const reloaded = new HotWordsStore({ dataDirectory });
  assert.equal(reloaded.entries[0].weight, 5);
  assert.equal(reloaded.snapshot().hotword, 'QueryForge|11');
});

test('显式 100 不挤掉上下文相关词，仍遵守 128 词上限和启用状态', t => {
  const { dataDirectory, store } = createStore(t);
  const entries = Array.from({ length: MAX_TERMS }, (_, index) => ({
    term: `ContextTerm${index}`, weight: 5, aliases: ['相关话题'], group: 'general',
  }));
  entries.push({ term: 'UnrelatedForced', weight: 100, updatedAt: Date.now(), group: 'general' });
  entries.push({ term: 'DisabledForced', weight: 100, enabled: false, aliases: ['相关话题'], group: 'general' });
  fs.writeFileSync(path.join(dataDirectory, 'hot-words.json'), JSON.stringify({ entries, managedWeights: true }));
  const snapshot = store.snapshot('相关话题');
  assert.equal(snapshot.selected, MAX_TERMS);
  assert.equal(snapshot.omitted, 1);
  assert.ok(snapshot.terms.every(term => term.startsWith('ContextTerm')));
  const withoutContext = store.snapshot();
  assert.equal(withoutContext.entries[0].term, 'UnrelatedForced');
  assert.ok(withoutContext.hotword.split(',').includes('UnrelatedForced|100'));
  assert.ok(!withoutContext.terms.includes('DisabledForced'));
});
