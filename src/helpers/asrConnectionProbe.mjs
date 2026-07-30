import { buildRealtimeAsrProtocols } from './realtimeAsrConnection.mjs';

const SAMPLE_RATE = 16000;
const AUDIO_DURATION_MS = 1000;
const PCM_BYTES = SAMPLE_RATE * 2;

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function silentPcmChunks() {
  const chunks = [];
  for (let offset = 0; offset < PCM_BYTES; offset += 3200) {
    chunks.push(new ArrayBuffer(Math.min(3200, PCM_BYTES - offset)));
  }
  return chunks;
}

async function parseMessageData(data) {
  if (typeof data === 'string') return JSON.parse(data);
  if (data && typeof data.text === 'function') return JSON.parse(await data.text());
  return JSON.parse(String(data));
}

export function formatProbeMetrics(metrics = {}) {
  const values = [];
  if (Number.isFinite(metrics.handshakeMs)) values.push(`握手 ${Math.round(metrics.handshakeMs)} ms`);
  if (Number.isFinite(metrics.readyMs)) values.push(`服务就绪 ${Math.round(metrics.readyMs)} ms`);
  if (Number.isFinite(metrics.uploadBytesPerSecond)) values.push(`上行 ${(metrics.uploadBytesPerSecond / 1024).toFixed(1)} KiB/s`);
  if (Number.isFinite(metrics.endToEndMs)) values.push(`端到端 ${Math.round(metrics.endToEndMs)} ms`);
  if (Number.isFinite(metrics.audioRealtimeFactor)) values.push(`实时倍率 ${metrics.audioRealtimeFactor.toFixed(2)}x`);
  return values.join(' · ');
}

export function probeAsrConnection(connection, { WebSocketImpl = WebSocket, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = now();
    let socket = null;
    let done = false;
    let handshakeAt = 0;
    let readyAt = 0;
    let uploadStartedAt = 0;
    let uploadFinishedAt = 0;
    let drainTimer = null;
    const finish = (result, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (drainTimer !== null) clearInterval(drainTimer);
      try { socket?.close(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(null, new Error('ASR 测试超时：服务未完成音频处理')), timeoutMs);
    try {
      const protocols = buildRealtimeAsrProtocols(connection?.token);
      socket = protocols.length ? new WebSocketImpl(connection.url, protocols) : new WebSocketImpl(connection.url);
    } catch (error) {
      finish(null, error);
      return;
    }
    socket.onopen = () => {
      handshakeAt = now();
      socket.send(JSON.stringify({ type: 'start', sample_rate: SAMPLE_RATE, language: 'zh', hotword: '', optimize_mode: false, translate_target: '', intent_mode: '' }));
    };
    socket.onmessage = async (event) => {
      let payload;
      try { payload = await parseMessageData(event.data); } catch { return; }
      if (payload?.success === false || payload?.type === 'error') {
        finish(null, new Error(payload?.error || payload?.message || 'ASR 服务拒绝测试请求'));
      } else if (payload?.type === 'ready' && !readyAt) {
        readyAt = now();
        uploadStartedAt = now();
        for (const chunk of silentPcmChunks()) socket.send(chunk);
        socket.send(JSON.stringify({ type: 'finish' }));
        drainTimer = setInterval(() => {
          if (!uploadFinishedAt && socket.bufferedAmount === 0) uploadFinishedAt = now();
        }, 10);
      } else if (payload?.type === 'final') {
        const finalAt = now();
        if (!uploadFinishedAt) uploadFinishedAt = finalAt;
        const processingMs = Math.max(1, finalAt - uploadStartedAt);
        finish({
          handshakeMs: handshakeAt - startedAt,
          readyMs: readyAt - startedAt,
          uploadBytesPerSecond: PCM_BYTES / Math.max(0.001, (uploadFinishedAt - uploadStartedAt) / 1000),
          endToEndMs: finalAt - startedAt,
          audioRealtimeFactor: (AUDIO_DURATION_MS / 1000) / (processingMs / 1000),
        });
      }
    };
    socket.onerror = () => finish(null, new Error('ASR WebSocket 连接或认证失败'));
    socket.onclose = (event) => {
      if (!done) finish(null, new Error(event?.reason || `ASR WebSocket 提前关闭 (${event?.code || 'unknown'})`));
    };
  });
}
