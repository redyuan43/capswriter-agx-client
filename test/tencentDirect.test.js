const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const { realtimeUrl, cloudRequest, normalizeSegments, joinSegments, STANDARD, MODEL2 } = require('../src/helpers/tencentProvider');
const { TencentQuota, freeSeconds } = require('../src/helpers/tencentQuota');
const { TencentDirectBridge } = require('../src/helpers/tencentDirectBridge');
const { HotWordsStore } = require('../src/platform/electron/hotWordsStore');
const { relayTencent } = require('../src/helpers/tencentRealtimeRelay');
const { EventEmitter } = require('events');

test('腾讯异常 JSON 和分句结构返回错误，不抛出未捕获异常', async () => {
  for (const malformed of [null, [], 42, { sentences: { sentence_list: {} } }, { sentences: { sentence_list: [null] } }]) {
    const events = [];
    class Socket extends EventEmitter {
      readyState = WebSocket.OPEN;
      send(raw) { events.push(JSON.parse(raw)); }
      close() {}
      terminate() {}
    }
    class Upstream extends Socket {
      constructor() { super(); queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(malformed)))); }
    }
    const client = new Socket();
    const relay = relayTencent(client, { provider: { realtimeUrl: () => 'ws://test.invalid' },
      quota: { begin: () => STANDARD, record() {}, status: () => ({}) },
      snapshot: { hotword: '', version: 'test' }, WebSocketImpl: Upstream });
    try {
      client.emit('message', Buffer.from('{"type":"start","sample_rate":16000}'), false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(events.at(-1).type, 'error');
    } finally { relay.cancel(); }
  }
});

test('腾讯控制通道拒绝 JSON null，不建立上游连接', () => {
  const client = new EventEmitter(), events = [];
  client.readyState = WebSocket.OPEN;
  client.send = raw => events.push(JSON.parse(raw));
  client.close = () => {};
  const relay = relayTencent(client, { provider: { realtimeUrl() { throw new Error('不应调用'); } }, quota: { record() {} } });
  try {
    assert.doesNotThrow(() => client.emit('message', Buffer.from('null'), false));
    assert.equal(events[0].type, 'error');
  } finally { relay.cancel(); }
});

const credentials = { tencentAppId: '123456', tencentSecretId: 'test-id', tencentSecretKey: 'test-secret' };
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-tencent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function packageWith(seconds) {
  return { SubProductCode: 'sp_asr_realtime_prepay', Unit: 'free|seconds', RestNumFloat: seconds, TotalNumFloat: 18000,
    EffectiveTime: '2026-01-01 00:00:00', ExpiryTime: '2099-01-01 00:00:00' };
}

test('实时签名先签中文原始参数再 URL 编码，普通版包含词时间戳', () => {
  const url = new URL(realtimeUrl(credentials, STANDARD, 'voice-123', '千问|5', 1790000000, 123));
  assert.equal(url.origin, 'wss://asr.cloud.tencent.com');
  assert.equal(url.searchParams.get('hotword_list'), '千问|5');
  assert.equal(url.searchParams.get('word_info'), '2');
  assert.equal(url.searchParams.get('signature'), '4LitpkOUyAf9Ecn52Mwkro1JY3M=');
  assert.equal(new URL(realtimeUrl(credentials, MODEL2, 'voice')).searchParams.has('word_info'), false);
});

test('额度 TC3 请求签名固定输入，正文与被签字节一致', () => {
  const request = cloudRequest(credentials, 'DescribePidOrders', { AvailableType: 0, Page: 1, PageSize: 100 }, 1790000000);
  assert.equal(request.body, '{"AvailableType":0,"Page":1,"PageSize":100}');
  assert.match(request.headers.Authorization, /^TC3-HMAC-SHA256 Credential=test-id\/2026-09-21\/asr\/tc3_request,/);
  assert.equal(request.headers['X-TC-Action'], 'DescribePidOrders');
});

test('两种腾讯结果保留句索引、时间戳和词信息，中英不粘词', () => {
  const classic = normalizeSegments({ result: { index: 0, voice_text_str: 'hello', slice_type: 2, start_time: 0, end_time: 300, word_list: [{ word: 'hello' }] } });
  const v2 = normalizeSegments({ sentences: { sentence_list: [{ sentence_id: 1, sentence_type: 1, sentence: 'world', start_time: 300, end_time: 800 }] } });
  assert.equal(classic[0].isFinal, true); assert.equal(v2[0].isFinal, true); assert.equal(v2[0].startTime, 300);
  assert.equal(joinSegments([...classic, ...v2]), 'hello world');
});

test('Float-only 额度包可解析，排除付费包和过期包', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  assert.equal(freeSeconds([packageWith('180')], now), 180);
  assert.equal(freeSeconds([{ ...packageWith(180), Unit: 'paid|seconds' }], now), null);
  assert.equal(freeSeconds([{ ...packageWith(180), ExpiryTime: '2026-01-02 00:00:00' }], now), null);
  assert.throws(() => freeSeconds([packageWith(-1)], now), /无效/);
});

test('额度选择与预留同步、余额不回弹、过期保守降级、重启记账', (t) => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  const dir = directory(t), quota = new TencentQuota({ dataDirectory: dir, clock: () => now });
  quota.observe(180);
  assert.equal(quota.begin('a'), STANDARD); assert.equal(quota.begin('b'), MODEL2);
  quota.record('a', 60, 'completed'); quota.observe(180);
  assert.equal(quota.status().quota.remaining_seconds, 120);
  assert.equal(quota.begin('c'), STANDARD);
  now += 91000; assert.equal(quota.status().engine, MODEL2);
  const restored = new TencentQuota({ dataDirectory: dir, clock: () => now });
  restored.observe(180); assert.equal(restored.status().quota.remaining_seconds, 0);
});

test('原生直连经过真实本机 WebSocket，免费版 4004 握手回退且只发送一次音频', { timeout: 5000 }, async (t) => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'hot-words.txt'), '千问|5\n');
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const connections = [], frames = [];
  upstream.on('connection', (socket, req) => {
    connections.push(req.url);
    if (req.url.includes(STANDARD) && !req.url.includes(MODEL2)) { socket.send(JSON.stringify({ code: 4004 })); return; }
    socket.send(JSON.stringify({ code: 0 }));
    socket.on('message', (raw, binary) => {
      if (binary) { frames.push({ size: raw.length, time: Date.now() }); return; }
      if (JSON.parse(raw).type === 'end') {
        socket.send(JSON.stringify({ code: 0, result: { index: 0, voice_text_str: 'hello', slice_type: 1 } }));
        socket.send(JSON.stringify({ code: 0, result: { index: 0, voice_text_str: 'Hello', slice_type: 2, start_time: 0, end_time: 200 } }));
        socket.send(JSON.stringify({ code: 0, sentences: { sentence_list: [{ sentence_id: 1, sentence: 'world', sentence_type: 1, start_time: 200, end_time: 400 }] } }));
        socket.send(JSON.stringify({ code: 0, final: 1 }));
      }
    });
  });
  const provider = { credentials: () => credentials, resources: async () => [packageWith(18000)],
    realtimeUrl: (engine, _id, words) => { assert.equal(words, '千问|5'); return `ws://127.0.0.1:${upstream.address().port}/${engine}`; } };
  const bridge = new TencentDirectBridge({ dataDirectory: dir, provider, hotWordsStore: new HotWordsStore({ dataDirectory: dir }) });
  t.after(() => { bridge.dispose(); for (const s of upstream.clients) s.terminate(); upstream.close(); });
  const connection = await bridge.connection();
  const unauthorized = await fetch(connection.httpBaseUrl.replace(bridge.prefix, '/wrong') + '/api/status');
  assert.equal(unauthorized.status, 403);
  assert.equal(bridge.authorized({ url: `${bridge.prefix}/api/status`, headers: { origin: 'https://example.com' } }), false);
  assert.equal(bridge.authorized({ url: '/wrong/api/status', headers: { origin: 'file://' } }), false);
  const client = new WebSocket(connection.url, ['qwen3-asr-v1'], { origin: 'file://' });
  const events = [];
  const final = new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (raw) => {
      const event = JSON.parse(raw); events.push(event);
      if (event.type === 'error') reject(new Error(event.error));
      if (event.type === 'ready') { client.send(Buffer.alloc(12800)); client.send(JSON.stringify({ type: 'finish' })); }
      if (event.type === 'final') resolve(event);
    });
  });
  await once(client, 'open'); client.send(JSON.stringify({ type: 'start', sample_rate: 16000, optimize_mode: 'none' }));
  const result = await final;
  assert.equal(result.text, 'Hello world'); assert.equal(result.segments.length, 2);
  assert.equal(result.engine, MODEL2); assert.equal(events.filter((e) => e.type === 'final').length, 1);
  assert.equal(connections.length, 2); assert.equal(frames.reduce((v, f) => v + f.size, 0), 12800);
  assert.ok(frames[1].time - frames[0].time >= 170);
  assert.equal(result.hotword, '千问|5'); assert.ok(result.dictionary_version);
});

test('文件入口经过本机 HTTP 与实际 ffmpeg 转码，SSE 一次最终结果并传相同词表', { timeout: 10000 }, async (t) => {
  const dir = directory(t); fs.writeFileSync(path.join(dir, 'hot-words.txt'), '千问|5\n');
  let calls = 0;
  const provider = { resources: async () => [], credentials: () => credentials,
    flash: async (bytes, hotword) => { calls++; assert.ok(bytes.length > 1000); assert.equal(hotword, '千问|5'); return { flash_result: [{ text: '文件结果。' }] }; } };
  const bridge = new TencentDirectBridge({ dataDirectory: dir, provider, hotWordsStore: new HotWordsStore({ dataDirectory: dir }) });
  t.after(() => bridge.dispose());
  const { httpBaseUrl } = await bridge.connection();
  const audio = Buffer.alloc(32044); audio.write('RIFF'); audio.writeUInt32LE(32036, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(32000, 40);
  const form = new FormData(); form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'test.wav'); form.append('optimize_mode', 'none');
  const response = await fetch(`${httpBaseUrl}/api/asr/transcribe-and-optimize-stream`, { method: 'POST', body: form });
  const events = (await response.text()).split('\n').filter((s) => s.startsWith('data:')).map((s) => JSON.parse(s.slice(5)));
  assert.equal(events.filter((e) => e.stage === 'done').length, 1, JSON.stringify(events));
  assert.equal(events.at(-1).text, '文件结果。'); assert.equal(calls, 1);
  assert.ok(events.at(-1).dictionary_version);
});
