const test = require('node:test');
const assert = require('node:assert/strict');

test('桌面与 M5 的整理入口保留识别快照、词时间戳及已经完成的文件整理', async () => {
  const { asrProcessingMetadata } = await import('../src/helpers/asrResultPolicy.mjs');
  const payload = { dictionary_version: 'recording-snapshot', hotword: 'Qwen|5',
    segments: [{ id: 1, words: [{ word: 'Qwen', start: 100, end: 200 }] }],
    processing: { text: 'Qwen。', mode: 'light' }, final_text: 'Qwen。',
    engine: '16k_zh', session_id: 'session', provider: 'tencent' };
  assert.deepEqual(asrProcessingMetadata(payload), payload);
  assert.deepEqual(asrProcessingMetadata(undefined), {});
  assert.deepEqual(asrProcessingMetadata({ text: '旧协议', success: true }), {});
});

test('同一录音并发完成只交付一次，下一次相同口述仍交付', async () => {
  const { createTextDelivery } = await import('../src/helpers/textDelivery.mjs');
  const deliver = createTextDelivery();
  let release, calls = 0;
  const task = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const first = deliver('相同口述', 1, task);
  const duplicate = deliver('相同口述', 1, task);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ ok: true, mode: 'copied' });
  assert.deepEqual(await first, await duplicate);
  assert.equal((await deliver('相同口述', 1, task)).mode, 'copied');
  const next = deliver('相同口述', 2, task);
  await Promise.resolve();
  assert.equal(calls, 2);
  release({ ok: true, mode: 'pasted' });
  assert.equal((await next).mode, 'pasted');
});

test('失败不写成功去重记录，旧请求失败不清除新录音的去重状态', async () => {
  const { createTextDelivery } = await import('../src/helpers/textDelivery.mjs');
  const deliver = createTextDelivery();
  let reject;
  const old = deliver('旧', 1, () => new Promise((_resolve, fail) => { reject = fail; }));
  await Promise.resolve();
  const current = await deliver('新', 2, async () => ({ ok: true, mode: 'copied' }));
  reject(new Error('失败'));
  assert.equal((await old).ok, false);
  assert.deepEqual(await deliver('新', 2, () => assert.fail('重复交付')), current);
  assert.equal((await deliver('失败', 3, async () => ({ ok: false, mode: 'failed' }))).ok, false);
  assert.equal((await deliver('失败', 3, async () => ({ ok: true, mode: 'pasted' }))).ok, true);
});
