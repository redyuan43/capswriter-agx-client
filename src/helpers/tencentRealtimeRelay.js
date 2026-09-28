const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { STANDARD, MODEL2, normalizeSegments, joinSegments } = require('./tencentProvider');
const FRAME = 6400, RATE = 32000, MAX_PENDING = RATE * 10;

// 主进程内的 PCM 适配器。云端 URL 与签名始终留在这里。
function relayTencent(client, { provider, quota, snapshot: initialSnapshot, getSnapshot, WebSocketImpl = WebSocket }) {
  let snapshot = initialSnapshot;
  const id = randomUUID();
  let upstream, engine, started = false, ready = false, finishing = false, done = false, endSent = false;
  let sent = 0, queued = Buffer.alloc(0), nextAt = 0, pumpTimer, helloTimer, finalTimer;
  const segments = new Map();
  const emit = (payload) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload)); };
  const payload = (type) => {
    const ordered = [...segments.values()].sort((a, b) => a.id - b.id);
    const text = joinSegments(ordered);
    return { type, success: true, text, asr_text: text, raw_text: text, final_text: text, partial_text: type === 'partial' ? text : '',
      segments: ordered, provider: 'tencent', engine, session_id: id, duration: sent / RATE,
      hotword: snapshot.hotword, dictionary_version: snapshot.version, optimize_mode: 'none', postprocess_mode: 'none' };
  };
  const stop = (state, message) => {
    if (done) return;
    done = true;
    clearTimeout(pumpTimer); clearTimeout(helloTimer); clearTimeout(finalTimer); clearTimeout(idleTimer);
    if (message) emit({ type: 'error', success: false, error: message, message });
    try { quota.record(id, sent / RATE, state); } catch { /* 主请求已结束，不能重复交付 */ }
    upstream?.terminate();
    client.close();
  };
  let idleTimer = setTimeout(() => stop('failed', '等待录音开始超时'), 10000);
  const refreshIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('failed', '录音数据超时'), 15000);
  };
  const pump = () => {
    if (done || !ready || endSent) return;
    clearTimeout(pumpTimer);
    if (queued.length < FRAME && !finishing) return;
    const wait = nextAt - performance.now();
    if (wait > 1) { pumpTimer = setTimeout(pump, wait); return; }
    if (upstream.bufferedAmount > MAX_PENDING) { stop('failed', '腾讯连接发送积压'); return; }
    if (queued.length) {
      const frame = queued.subarray(0, FRAME);
      queued = queued.subarray(frame.length);
      upstream.send(frame, (error) => { if (error) stop('failed', '腾讯音频发送失败'); });
      nextAt = Math.max(nextAt, performance.now()) + frame.length / RATE * 1000;
      const before = Math.floor(sent / RATE);
      sent += frame.length;
      if (sent > RATE * 7200) { stop('failed', '单次录音不能超过两小时'); return; }
      try { if (Math.floor(sent / RATE) > before) quota.record(id, sent / RATE); }
      catch { stop('failed', '本地额度记录失败'); return; }
      pumpTimer = setTimeout(pump, Math.max(1, nextAt - performance.now()));
    } else if (finishing) {
      endSent = true;
      upstream.send(JSON.stringify({ type: 'end' }));
      finalTimer = setTimeout(() => stop('failed', '腾讯最终结果超时'), 12000);
    }
  };

  const connect = (retry = false) => {
    try {
      upstream = new WebSocketImpl(provider.realtimeUrl(engine, randomUUID(), snapshot.hotword), { handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024 });
    } catch { stop('failed', '腾讯凭据不可用或连接失败'); return; }
    const socket = upstream;
    helloTimer = setTimeout(() => stop('failed', '腾讯握手超时'), 10000);
    socket.on('message', (raw) => {
      if (done || socket !== upstream) return;
      let data;
      try { data = JSON.parse(raw.toString()); } catch { stop('failed', '腾讯返回无效数据'); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { stop('failed', '腾讯返回无效数据'); return; }
      let normalized;
      try { normalized = normalizeSegments(data); }
      catch { stop('failed', '腾讯返回无效分句数据'); return; }
      if (data.code && data.code !== 0) {
        if (Number(data.code) === 4004 && engine === STANDARD) {
          try { quota.exhausted(); } catch { stop('failed', '本地额度记录失败'); return; }
        }
        if (Number(data.code) === 4004 && !sent && !ready && engine === STANDARD && !retry) {
          clearTimeout(helloTimer);
          socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate();
          try { quota.record(id, 0, 'failed'); engine = quota.begin(id, MODEL2); }
          catch { stop('failed', '本地额度记录失败'); return; }
          connect(true); return;
        }
        stop('failed', `腾讯识别失败（${Number(data.code) || 'unknown'}）`); return;
      }
      if (!ready) {
        ready = true;
        clearTimeout(helloTimer);
        emit({ type: 'ready', success: true, provider: 'tencent', engine, session_id: id, ...quota.status(),
          hotword: snapshot.hotword, dictionary_version: snapshot.version,
          capabilities: { asr: true, optimize: false, translate: false } });
      }
      for (const segment of normalized) {
        if (!segments.get(segment.id)?.isFinal || segment.isFinal) segments.set(segment.id, segment);
      }
      if (data.final === 1) {
        if (!endSent) { stop('failed', '腾讯提前结束会话'); return; }
        emit(payload('final')); stop('completed');
      } else if (normalized.length) emit(payload('partial'));
    });
    socket.on('error', () => { if (socket === upstream) stop('failed', '腾讯连接失败'); });
    socket.on('close', () => { if (socket === upstream && !done) stop('failed', '腾讯连接在最终结果前断开'); });
  };

  client.on('message', (raw, binary) => {
    if (done) return;
    refreshIdle();
    if (binary) {
      if (!ready || finishing || raw.length % 2 || queued.length + raw.length > MAX_PENDING) { stop('failed', 'PCM 音频状态、格式或队列大小无效'); return; }
      queued = Buffer.concat([queued, raw]); pump(); return;
    }
    let command;
    try { command = JSON.parse(raw.toString()); } catch { stop('failed', '录音控制消息无效'); return; }
    if (!command || typeof command !== 'object' || Array.isArray(command)) { stop('failed', '录音控制消息无效'); return; }
    if (command.type === 'cancel') { stop('cancelled'); return; }
    if (command.type === 'start' && !started) {
      if (command.sample_rate !== 16000 || !['none', '', undefined, false].includes(command.optimize_mode)) { stop('failed', '腾讯直连需要 16000 Hz PCM；翻译请另选连接'); return; }
      started = true;
      try { snapshot = getSnapshot?.() || initialSnapshot; engine = quota.begin(id); } catch { stop('failed', '本地词库或额度记录失败'); return; }
      connect(); return;
    }
    if (command.type === 'finish' && ready && !finishing) { finishing = true; pump(); return; }
    stop('failed', '录音控制消息顺序无效');
  });
  client.once('close', () => stop('cancelled'));
  client.once('error', () => stop('failed'));
  return { cancel: () => stop('cancelled') };
}

module.exports = { relayTencent };
