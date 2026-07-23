// src/services/backendAPI.js
/**
 * 语音转写后端API客户端
 * 封装与GPU加速后端的通信
 */

import axios from 'axios';
import backendConfig from '../config/backend.js';

const TTS_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TTS_REQUEST_TIMEOUT_MS || 120000);
const TRANSLATE_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TRANSLATE_REQUEST_TIMEOUT_MS || 20000);
const TTS_PLAN_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TTS_PLAN_REQUEST_TIMEOUT_MS || 10000);
const TTS_CONTROL_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TTS_CONTROL_REQUEST_TIMEOUT_MS || 10000);
const ASR_STREAM_CONNECT_TIMEOUT_MS = Number(import.meta.env.VITE_ASR_STREAM_CONNECT_TIMEOUT_MS || 15000);
const ASR_STREAM_IDLE_TIMEOUT_MS = Number(import.meta.env.VITE_ASR_STREAM_IDLE_TIMEOUT_MS || 20000);
const DEFAULT_REALTIME_ASR_URL = 'ws://agx.taild500c8.ts.net:18011/api/asr/realtime';
const REALTIME_ASR_URL = (import.meta.env.VITE_REALTIME_ASR_URL || DEFAULT_REALTIME_ASR_URL).trim();
const REALTIME_ASR_CONNECT_TIMEOUT_MS = Number(import.meta.env.VITE_REALTIME_ASR_CONNECT_TIMEOUT_MS || 2500);
const REALTIME_ASR_FINAL_TIMEOUT_MS = Number(import.meta.env.VITE_REALTIME_ASR_FINAL_TIMEOUT_MS || 15000);
const REALTIME_ASR_FINAL_TIMEOUT_MAX_MS = Number(import.meta.env.VITE_REALTIME_ASR_FINAL_TIMEOUT_MAX_MS || 120000);
const REALTIME_ASR_FINAL_TIMEOUT_AUDIO_RATIO = Number(import.meta.env.VITE_REALTIME_ASR_FINAL_TIMEOUT_AUDIO_RATIO || 1.5);
const REALTIME_ASR_PCM_STALL_TIMEOUT_MS = Number(import.meta.env.VITE_REALTIME_ASR_PCM_STALL_TIMEOUT_MS || 3500);
const REALTIME_ASR_PCM_WATCHDOG_INTERVAL_MS = 500;
const REALTIME_ASR_PREROLL_MS = Number(import.meta.env.VITE_REALTIME_ASR_PREROLL_MS || 5000);
const SERVER_LLM_MODEL = import.meta.env.VITE_SERVER_LLM_MODEL || 'caps-voice-edit-qwen3-4b';
const TTS_SPEAKER_DISPLAY_NAMES = {
  vivian: 'Vivian',
  serena: 'Serena',
  uncle_fu: 'Uncle_Fu',
  dylan: 'Dylan',
  eric: 'Eric',
  ryan: 'Ryan',
  aiden: 'Aiden',
  ono_anna: 'Ono_Anna',
  sohee: 'Sohee',
};
const QWEN3_TTS_CUSTOM_VOICE_SPEAKERS = [
  'Vivian',
  'Serena',
  'Uncle_Fu',
  'Dylan',
  'Eric',
  'Ryan',
  'Aiden',
  'Ono_Anna',
  'Sohee',
];

function normalizePositiveInteger(value, { low = 1, high = 64 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.floor(number);
  if (integer < low) return null;
  return Math.max(low, Math.min(high, integer));
}

function extractTtsWorkerCount(payload, high = 8) {
  if (!payload || typeof payload !== 'object') return null;
  for (const value of [
    payload.tts_parallel_workers_ready,
    payload.tts_workers_ready,
    payload.workers_ready,
    payload.client_defaults?.recommended_speak_concurrency
  ]) {
    const normalized = normalizePositiveInteger(value, { low: 1, high });
    if (normalized) return normalized;
  }
  if (Array.isArray(payload.workers)) {
    const readyWorkers = payload.workers.filter((worker) => {
      const status = String(worker?.status || '').toLowerCase();
      return worker?.ready === true || status === 'ready';
    }).length;
    return normalizePositiveInteger(readyWorkers, { low: 1, high });
  }
  return null;
}

const apiClient = axios.create({
  timeout: backendConfig.timeout,
  headers: {
    'Content-Type': 'application/json'
  }
});

async function getBaseURL() {
  try {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.getSetting) {
      const url = await window.electronAPI.getSetting('backend_url', backendConfig.baseURL);
      if (url && typeof url === 'string' && url.trim()) return url.trim();
    }
  } catch {
    // Silently fallback
  }
  return backendConfig.baseURL;
}

async function getTtsBaseURL() {
  try {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.getSetting) {
      const url = await window.electronAPI.getSetting('tts_base_url', backendConfig.ttsBaseURL);
      if (url && typeof url === 'string' && url.trim()) return url.trim();
    }
  } catch {
    // Silently fallback
  }
  return backendConfig.ttsBaseURL;
}

function inferRealtimeSiblingURL(value, pathname) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return '';
    }
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function getServerLlmURL() {
  return inferRealtimeSiblingURL(REALTIME_ASR_URL, '/api/llm/chat');
}

apiClient.interceptors.request.use(
  config => {
    return config;
  },
  error => {
    return Promise.reject(error);
  }
);

apiClient.interceptors.response.use(
  response => {
    return response;
  },
  error => {
    console.error('[API] Error:', error.message);
    return Promise.reject(error);
  }
);

function inferAudioUploadFilename(audioBlob) {
  const mimeType = (audioBlob?.type || '').toLowerCase();
  if (mimeType.includes('webm')) return 'audio.webm';
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('wav')) return 'audio.wav';
  return 'audio.bin';
}

function resampleFloat32(input, sourceSampleRate, targetSampleRate) {
  if (!input?.length || sourceSampleRate === targetSampleRate) {
    return input || new Float32Array(0);
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(0, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, input.length - 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function float32ToInt16LE(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

function withClientTimeout(promise, timeoutMs, message) {
  let timerId = null;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  });
}

function cleanTranslationOutput(value) {
  let text = String(value || '').trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (text.startsWith('```') && text.endsWith('```')) {
    const lines = text.split(/\r?\n/);
    if (lines.length >= 3) {
      text = lines.slice(1, -1).join('\n').trim();
    }
  }
  return text.replace(/^(translation|译文)\s*[:：]\s*/i, '').trim();
}

function serverLlmChat(messages, options = {}) {
  const url = getServerLlmURL();
  if (!url) {
    return Promise.reject(new Error('Server LLM URL is not configured'));
  }

  return new Promise((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      reject(new Error('当前运行环境不支持 WebSocket'));
      return;
    }

    let settled = false;
    let socket = null;
    const timeoutMs = normalizePositiveNumber(options.timeoutMs, TRANSLATE_REQUEST_TIMEOUT_MS);
    const timerId = setTimeout(() => {
      settleReject(new Error(`Server LLM timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timerId);
      try {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
          socket.close();
        }
      } catch {
        // Best effort cleanup.
      }
    };
    const settleResolve = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    try {
      socket = new WebSocket(url);
    } catch (error) {
      settleReject(error);
      return;
    }

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'chat',
        model: options.model || SERVER_LLM_MODEL,
        messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens || 256,
        stream: false
      }));
    };
    socket.onmessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        settleReject(new Error('Server LLM returned invalid JSON'));
        return;
      }
      if (payload?.success === false || payload?.type === 'error') {
        settleReject(new Error(payload?.error || payload?.message || 'Server LLM request failed'));
        return;
      }
      const text = payload?.text || payload?.data?.choices?.[0]?.message?.content || '';
      if (payload?.type === 'chat_completion' || text) {
        settleResolve({ payload, text });
      }
    };
    socket.onerror = () => settleReject(new Error('Server LLM websocket error'));
    socket.onclose = (event) => {
      if (!settled) {
        settleReject(new Error(event?.reason || `Server LLM closed (${event?.code || 'unknown'})`));
      }
    };
  });
}

async function translateTextWithServerLlm(text, target = 'zh', options = {}) {
  const sourceText = String(text || '').trim();
  if (!sourceText) {
    return '';
  }

  const normalizedTarget = String(target || 'zh').toLowerCase() === 'en' ? 'English' : 'Simplified Chinese';
  const { text: rawText } = await serverLlmChat([
    {
      role: 'system',
      content: 'You are a fast machine translation engine. Output only the translated text. Do not include reasoning, analysis, markdown, labels, or <think> blocks.'
    },
    {
      role: 'user',
      content: `Target language: ${normalizedTarget}\nText:\n${sourceText}`
    }
  ], {
    timeoutMs: options.timeoutMs,
    temperature: 0,
    maxTokens: 256
  });

  const translatedText = cleanTranslationOutput(rawText);
  if (!translatedText) {
    throw new Error('Server LLM returned empty translation');
  }
  return translatedText;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function computeRealtimeASRFinalTimeoutMs(audioDurationMs = 0) {
  const baseMs = normalizePositiveNumber(REALTIME_ASR_FINAL_TIMEOUT_MS, 15000);
  const maxMs = Math.max(baseMs, normalizePositiveNumber(REALTIME_ASR_FINAL_TIMEOUT_MAX_MS, 120000));
  const ratio = normalizePositiveNumber(REALTIME_ASR_FINAL_TIMEOUT_AUDIO_RATIO, 1.5);
  const durationMs = Math.max(0, normalizePositiveNumber(audioDurationMs, 0));
  return Math.min(maxMs, Math.max(baseMs, Math.ceil(baseMs + durationMs * ratio)));
}

export function isRealtimeASRConfigured() {
  return Boolean(REALTIME_ASR_URL);
}

export async function isHttpBackendConfigured() {
  const baseURL = String(await getBaseURL() || '').trim();
  return /^https?:\/\//i.test(baseURL);
}

export async function learnHotwords(terms, options = {}) {
  const normalizedTerms = (Array.isArray(terms) ? terms : [terms])
    .filter((term) => typeof term === 'string')
    .map((term) => term.trim())
    .filter(Boolean);
  if (!normalizedTerms.length) {
    return {
      success: true,
      added: [],
      added_count: 0,
      existing: [],
      existing_count: 0,
      invalid: [],
      invalid_count: 0
    };
  }
  const baseURL = String(await getBaseURL() || '').trim();
  if (!/^https?:\/\//i.test(baseURL)) {
    return learnHotwordsOverWebSocket(normalizedTerms, options);
  }
  const response = await apiClient.post(
    `${baseURL}${backendConfig.endpoints.learnHotwords}`,
    {
      terms: normalizedTerms,
      source: options.source || 'clipboard'
    }
  );
  return response.data;
}

function learnHotwordsOverWebSocket(terms, options = {}) {
  const url = inferRealtimeSiblingURL(REALTIME_ASR_URL, '/api/hotwords/learn');
  if (!url) {
    throw new Error('Hotword learning endpoint is not configured');
  }
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前浏览器不支持 WebSocket');
  }

  return withClientTimeout(new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
      handler(value);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'learn_hotwords',
        terms,
        source: options.source || 'clipboard'
      }));
    };
    ws.onerror = () => settle(reject, new Error('Hotword learning websocket error'));
    ws.onclose = () => {
      if (!settled) {
        settle(reject, new Error('Hotword learning websocket closed before response'));
      }
    };
    ws.onmessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        settle(reject, new Error('Hotword learning returned invalid JSON'));
        return;
      }
      const type = String(payload?.type || '').toLowerCase();
      if (payload?.success === false || type === 'error') {
        settle(reject, new Error(payload?.error || payload?.message || 'Hotword learning failed'));
        return;
      }
      if (type === 'hotwords_learned') {
        settle(resolve, payload);
      }
    };
  }), 10000, 'Hotword learning timeout (10000ms)');
}

export class RealtimeASRSession {
  constructor(mediaStream, options = {}) {
    this.mediaStream = mediaStream;
    this.url = options.url || REALTIME_ASR_URL;
    this.language = options.language || '';
    this.hotword = options.hotword || '';
    this.optimizeMode = options.optimizeMode || 'none';
    this.translateTarget = options.translateTarget || 'zh';
    this.intentMode = options.intentMode || 'none';
    this.clientIntents = Array.isArray(options.clientIntents) ? options.clientIntents : [];
    this.clientIntentConfidenceThreshold = Number.isFinite(Number(options.clientIntentConfidenceThreshold))
      ? Number(options.clientIntentConfidenceThreshold)
      : 0.78;
    this.onEvent = options.onEvent || null;
    this.onClientEvent = options.onClientEvent || null;
    this.targetSampleRate = 16000;
    this.prerollMs = normalizePositiveNumber(options.prerollMs, REALTIME_ASR_PREROLL_MS);
    this.maxPrerollBytes = Math.round(this.targetSampleRate * 2 * (this.prerollMs / 1000));
    this.prerollChunks = [];
    this.prerollBytes = 0;
    this.websocket = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.started = false;
    this.stopped = false;
    this.finalPayload = null;
    this.latestTextPayload = null;
    this.sentAudioBytes = 0;
    this.lastPcmSentAt = 0;
    this.audioPumpStartedAt = 0;
    this.audioPumpStalled = false;
    this.audioPumpStallInfo = null;
    this.audioPumpWatchdogTimer = null;
    this.finalResolve = null;
    this.finalReject = null;
    this.finalPromise = new Promise((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });
    this.finalPromise.catch(() => {});
  }

  async start() {
    if (!this.url) {
      throw new Error('Realtime ASR URL is not configured');
    }
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前浏览器不支持 WebSocket');
    }

    try {
      await this.startAudioPump();
      await withClientTimeout(this.openWebSocket(), REALTIME_ASR_CONNECT_TIMEOUT_MS, `Realtime ASR connect timeout (${REALTIME_ASR_CONNECT_TIMEOUT_MS}ms)`);
      if (this.stopped) {
        throw new Error('Realtime ASR session was cancelled before audio pump started');
      }
      this.started = true;
      this.startAudioPumpWatchdog();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  openWebSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.websocket = ws;
      let ready = false;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'start',
          sample_rate: this.targetSampleRate,
          language: this.language,
          hotword: this.hotword,
          optimize_mode: this.optimizeMode,
          translate_target: this.translateTarget,
          intent_mode: this.intentMode,
          client_intents: this.intentMode === 'client_intent' ? this.clientIntents : [],
          client_intent_confidence_threshold: this.clientIntentConfidenceThreshold,
        }));
        this.flushPreroll();
      };

      ws.onerror = () => {
        const error = new Error('Realtime ASR websocket error');
        if (!ready) {
          reject(error);
        } else if (!this.finalPayload) {
          this.finalReject(error);
        }
      };

      ws.onclose = () => {
        if (!ready) {
          reject(new Error('Realtime ASR websocket closed before ready'));
        } else if (!this.finalPayload && !this.stopped) {
          this.finalReject(new Error('Realtime ASR websocket closed before final'));
        }
      };

      ws.onmessage = (event) => {
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (typeof this.onEvent === 'function') {
          this.onEvent(payload);
        }

        const type = (payload?.type || '').toLowerCase();
        if (type === 'partial' || type === 'final') {
          this.latestTextPayload = payload;
        }
        if (type === 'ready') {
          ready = true;
          resolve(payload);
          return;
        }
        if (type === 'final') {
          this.finalPayload = payload;
          this.finalResolve(payload);
          return;
        }
        if (type === 'closed') {
          if (!this.finalPayload) {
            this.finalReject(new Error(payload?.error || payload?.message || 'Realtime ASR closed before final'));
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
          return;
        }
        if (type === 'error') {
          const error = new Error(payload?.error || payload?.message || 'Realtime ASR returned an error event');
          if (!ready) {
            reject(error);
          } else {
            this.finalReject(error);
          }
        }
      };
    });
  }

  enqueuePreroll(buffer) {
    if (!buffer?.byteLength || this.maxPrerollBytes <= 0) {
      return;
    }
    this.prerollChunks.push(buffer);
    this.prerollBytes += buffer.byteLength;
    while (this.prerollBytes > this.maxPrerollBytes && this.prerollChunks.length > 0) {
      const dropped = this.prerollChunks.shift();
      this.prerollBytes -= dropped?.byteLength || 0;
    }
  }

  emitClientEvent(payload) {
    if (typeof this.onClientEvent === 'function') {
      this.onClientEvent(payload);
    }
  }

  flushPreroll() {
    if (this.websocket?.readyState !== WebSocket.OPEN || this.prerollChunks.length === 0) {
      return;
    }
    const chunks = this.prerollChunks;
    const bytes = this.prerollBytes;
    this.prerollChunks = [];
    this.prerollBytes = 0;
    for (const chunk of chunks) {
      if (this.websocket?.readyState !== WebSocket.OPEN) {
        this.enqueuePreroll(chunk);
        return;
      }
      this.websocket.send(chunk);
      this.recordPcmSent(chunk.byteLength);
    }
    this.emitClientEvent({
      type: 'preroll_flushed',
      chunks: chunks.length,
      bytes,
      durationMs: Math.round((bytes / 2 / this.targetSampleRate) * 1000),
    });
  }

  async startAudioPump() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('AudioContext unavailable');
    }

    this.audioContext = new AudioContextCtor();
    await this.audioContext.resume().catch(() => {});
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      if (this.stopped) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = float32ToInt16LE(resampleFloat32(input, this.audioContext.sampleRate, this.targetSampleRate));
      if (pcm16.byteLength > 0) {
        if (this.websocket?.readyState === WebSocket.OPEN) {
          this.flushPreroll();
          this.websocket.send(pcm16);
          this.recordPcmSent(pcm16.byteLength);
        } else {
          this.enqueuePreroll(pcm16);
        }
      }
    };
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
  }

  stopAudioPump() {
    this.stopped = true;
    this.stopAudioPumpWatchdog();
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.prerollChunks = [];
    this.prerollBytes = 0;
  }

  getLatestTextPayload() {
    if (!this.latestTextPayload) {
      return null;
    }
    return { ...this.latestTextPayload };
  }

  hasSentAudio() {
    return this.sentAudioBytes > 0;
  }

  isAudioPumpStalled() {
    return this.audioPumpStalled;
  }

  recordPcmSent(byteLength) {
    if (!byteLength) {
      return;
    }
    this.sentAudioBytes += byteLength;
    this.lastPcmSentAt = Date.now();
  }

  startAudioPumpWatchdog() {
    const timeoutMs = normalizePositiveNumber(REALTIME_ASR_PCM_STALL_TIMEOUT_MS, 3500);
    this.audioPumpStartedAt = Date.now();
    const check = () => {
      if (this.stopped || this.audioPumpStalled) {
        return;
      }
      const lastActivityAt = this.lastPcmSentAt || this.audioPumpStartedAt;
      const silentForMs = Date.now() - lastActivityAt;
      if (silentForMs >= timeoutMs) {
        this.audioPumpStalled = true;
        this.audioPumpStallInfo = {
          timeoutMs,
          silentForMs,
          sentAudioBytes: this.sentAudioBytes,
        };
        this.emitClientEvent({
          type: 'realtime_pcm_watchdog_stalled',
          ...this.audioPumpStallInfo,
        });
        this.cancel();
        return;
      }
      this.audioPumpWatchdogTimer = window.setTimeout(
        check,
        Math.min(REALTIME_ASR_PCM_WATCHDOG_INTERVAL_MS, timeoutMs)
      );
    };
    this.audioPumpWatchdogTimer = window.setTimeout(
      check,
      Math.min(REALTIME_ASR_PCM_WATCHDOG_INTERVAL_MS, timeoutMs)
    );
  }

  stopAudioPumpWatchdog() {
    if (this.audioPumpWatchdogTimer !== null) {
      window.clearTimeout(this.audioPumpWatchdogTimer);
      this.audioPumpWatchdogTimer = null;
    }
  }

  async finish(options = {}) {
    this.stopAudioPump();
    if (!this.started || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime ASR session is not open');
    }
    const timeoutMs = normalizePositiveNumber(
      options.timeoutMs,
      normalizePositiveNumber(REALTIME_ASR_FINAL_TIMEOUT_MS, 15000)
    );
    this.websocket.send(JSON.stringify({ type: 'finish' }));
    const payload = await withClientTimeout(
      this.finalPromise,
      timeoutMs,
      `Realtime ASR final timeout (${timeoutMs}ms)`
    );
    this.websocket.close();
    return payload;
  }

  cancel() {
    this.stopAudioPump();
    if (!this.websocket) {
      return;
    }
    if (this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: 'cancel' }));
      this.websocket.close();
    } else if (this.websocket.readyState === WebSocket.CONNECTING) {
      this.websocket.close();
    }
  }
}

export class ExternalPCMRealtimeSession {
  constructor(options = {}) {
    this.url = options.url || REALTIME_ASR_URL;
    this.language = options.language || '';
    this.hotword = options.hotword || '';
    this.optimizeMode = options.optimizeMode || 'none';
    this.translateTarget = options.translateTarget || 'zh';
    this.intentMode = options.intentMode || 'none';
    this.clientIntents = Array.isArray(options.clientIntents) ? options.clientIntents : [];
    this.clientIntentConfidenceThreshold = Number.isFinite(Number(options.clientIntentConfidenceThreshold))
      ? Number(options.clientIntentConfidenceThreshold)
      : 0.78;
    this.onEvent = options.onEvent || null;
    this.targetSampleRate = Number(options.sampleRate || 16000);
    this.websocket = null;
    this.started = false;
    this.stopped = false;
    this.finalPayload = null;
    this.latestTextPayload = null;
    this.pendingChunks = [];
    this.finalPromise = new Promise((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });
    this.finalPromise.catch(() => {});
  }

  async start() {
    if (!this.url) {
      throw new Error('Realtime ASR URL is not configured');
    }
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前浏览器不支持 WebSocket');
    }
    await withClientTimeout(this.openWebSocket(), REALTIME_ASR_CONNECT_TIMEOUT_MS, `Realtime ASR connect timeout (${REALTIME_ASR_CONNECT_TIMEOUT_MS}ms)`);
    this.started = true;
    this.flushPendingChunks();
  }

  openWebSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.websocket = ws;
      let ready = false;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'start',
          sample_rate: this.targetSampleRate,
          language: this.language,
          hotword: this.hotword,
          optimize_mode: this.optimizeMode,
          translate_target: this.translateTarget,
          intent_mode: this.intentMode,
          client_intents: this.intentMode === 'client_intent' ? this.clientIntents : [],
          client_intent_confidence_threshold: this.clientIntentConfidenceThreshold,
        }));
      };

      ws.onerror = () => {
        const error = new Error('Realtime ASR websocket error');
        if (!ready) {
          reject(error);
        } else if (!this.finalPayload) {
          this.finalReject(error);
        }
      };

      ws.onclose = () => {
        if (!ready) {
          reject(new Error('Realtime ASR websocket closed before ready'));
        } else if (!this.finalPayload && !this.stopped) {
          this.finalReject(new Error('Realtime ASR websocket closed before final'));
        }
      };

      ws.onmessage = (event) => {
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof this.onEvent === 'function') {
          this.onEvent(payload);
        }
        const type = (payload?.type || '').toLowerCase();
        if (type === 'partial' || type === 'final') {
          this.latestTextPayload = payload;
        }
        if (type === 'ready') {
          ready = true;
          resolve(payload);
          return;
        }
        if (type === 'final') {
          this.finalPayload = payload;
          this.finalResolve(payload);
          return;
        }
        if (type === 'closed') {
          if (!this.finalPayload) {
            this.finalReject(new Error(payload?.error || payload?.message || 'Realtime ASR closed before final'));
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
          return;
        }
        if (type === 'error') {
          const error = new Error(payload?.error || payload?.message || 'Realtime ASR returned an error event');
          if (!ready) {
            reject(error);
          } else {
            this.finalReject(error);
          }
        }
      };
    });
  }

  sendPCM(chunk) {
    if (this.stopped || !chunk?.byteLength) {
      return;
    }
    const buffer = chunk instanceof ArrayBuffer
      ? chunk
      : chunk.buffer.slice(chunk.byteOffset || 0, (chunk.byteOffset || 0) + chunk.byteLength);
    if (this.websocket?.readyState === WebSocket.OPEN && this.started) {
      this.websocket.send(buffer);
      return;
    }
    this.pendingChunks.push(buffer);
  }

  flushPendingChunks() {
    if (this.websocket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    for (const chunk of chunks) {
      this.websocket.send(chunk);
    }
  }

  getLatestTextPayload() {
    if (!this.latestTextPayload) {
      return null;
    }
    return { ...this.latestTextPayload };
  }

  async finish(options = {}) {
    this.stopped = true;
    if (!this.started || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      throw new Error('Realtime ASR session is not open');
    }
    this.flushPendingChunks();
    const timeoutMs = normalizePositiveNumber(
      options.timeoutMs,
      normalizePositiveNumber(REALTIME_ASR_FINAL_TIMEOUT_MS, 15000)
    );
    this.websocket.send(JSON.stringify({ type: 'finish' }));
    const payload = await withClientTimeout(
      this.finalPromise,
      timeoutMs,
      `Realtime ASR final timeout (${timeoutMs}ms)`
    );
    this.websocket.close();
    return payload;
  }

  cancel() {
    this.stopped = true;
    this.pendingChunks = [];
    if (!this.websocket) {
      return;
    }
    if (this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: 'cancel' }));
      this.websocket.close();
    } else if (this.websocket.readyState === WebSocket.CONNECTING) {
      this.websocket.close();
    }
  }
}

export async function transcribeAudio(audioBlob, options = {}) {
  const {
    useVad = true,
    usePunc = true,
    hotword = '',
    intentMode = 'none',
    clientIntents = [],
    clientIntentConfidenceThreshold = 0.78,
  } = options;

  const formData = new FormData();
  formData.append('audio', audioBlob, inferAudioUploadFilename(audioBlob));
  formData.append('use_vad', useVad);
  formData.append('use_punc', usePunc);
  formData.append('hotword', hotword);
  formData.append('intent_mode', intentMode);
  if (intentMode === 'client_intent') {
    formData.append('client_intents_json', JSON.stringify(Array.isArray(clientIntents) ? clientIntents : []));
    formData.append('client_intent_confidence_threshold', String(clientIntentConfidenceThreshold));
  }

  try {
    const response = await apiClient.post(
      `${await getBaseURL()}${backendConfig.endpoints.transcribe}`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Transcription failed:', error);
    throw error;
  }
}

export async function transcribeAudioStream(audioBlob, options = {}) {
  const {
    useVad = true,
    usePunc = true,
    hotword = '',
    optimizeMode = 'none',
    translateTarget = 'zh',
    intentMode = 'none',
    clientIntents = [],
    clientIntentConfidenceThreshold = 0.78,
    onEvent = null
  } = options;

  const formData = new FormData();
  formData.append('audio', audioBlob, inferAudioUploadFilename(audioBlob));
  formData.append('use_vad', useVad);
  formData.append('use_punc', usePunc);
  formData.append('hotword', hotword);
  formData.append('optimize_mode', optimizeMode);
  formData.append('intent_mode', intentMode);
  if (intentMode === 'client_intent') {
    formData.append('client_intents_json', JSON.stringify(Array.isArray(clientIntents) ? clientIntents : []));
    formData.append('client_intent_confidence_threshold', String(clientIntentConfidenceThreshold));
  }
  if ((optimizeMode || '').toLowerCase() === 'translate') {
    formData.append('translate_target', translateTarget || 'zh');
  }

  const controller = new AbortController();
  let connectTimedOut = false;
  let idleTimedOut = false;
  let idleTimerId = null;
  const resetIdleTimer = () => {
    if (idleTimerId !== null) {
      clearTimeout(idleTimerId);
    }
    idleTimerId = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, ASR_STREAM_IDLE_TIMEOUT_MS);
  };

  const connectTimerId = setTimeout(() => {
    connectTimedOut = true;
    controller.abort();
  }, ASR_STREAM_CONNECT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(
      `${await getBaseURL()}${backendConfig.endpoints.transcribeAndOptimizeStream}`,
      {
        method: 'POST',
        body: formData,
        headers: {
          Accept: 'text/event-stream'
        },
        signal: controller.signal
      }
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (connectTimedOut) {
        throw new Error(`ASR stream connect timeout (${ASR_STREAM_CONNECT_TIMEOUT_MS}ms)`);
      }
      if (idleTimedOut) {
        throw new Error(`ASR stream idle timeout (${ASR_STREAM_IDLE_TIMEOUT_MS}ms)`);
      }
      throw new Error('ASR stream aborted');
    }
    throw error;
  } finally {
    clearTimeout(connectTimerId);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Stream request failed (${response.status}): ${detail || response.statusText}`);
  }
  if (!response.body) {
    throw new Error('Stream response body is empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalPayload = null;

  const handlePayload = (payload) => {
    if (typeof onEvent === 'function') {
      onEvent(payload);
    }
    if ((payload?.stage || '').toLowerCase() === 'done') {
      finalPayload = payload;
    }
    if ((payload?.stage || '').toLowerCase() === 'error') {
      throw new Error(payload?.error || payload?.message || 'Stream returned an error event');
    }
  };

  while (true) {
    resetIdleTimer();
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (idleTimedOut) {
          throw new Error(`ASR stream idle timeout (${ASR_STREAM_IDLE_TIMEOUT_MS}ms)`);
        }
        throw new Error('ASR stream read aborted');
      }
      throw error;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      try {
        const payload = JSON.parse(dataStr);
        handlePayload(payload);
      } catch (e) {
        console.warn('[API] Ignore malformed SSE payload:', e);
      }
    }
  }

  const rest = buffer.trim();
  if (rest.startsWith('data:')) {
    const dataStr = rest.slice(5).trim();
    if (dataStr) {
      const payload = JSON.parse(dataStr);
      handlePayload(payload);
    }
  }

  if (!finalPayload) {
    throw new Error('Stream finished without done event');
  }
  if (idleTimerId !== null) {
    clearTimeout(idleTimerId);
  }
  return finalPayload;
}

export async function optimizeText(text, mode = 'optimize', customPrompt = null) {
  try {
    const response = await apiClient.post(
      `${await getBaseURL()}${backendConfig.endpoints.optimize}`,
      {
        text,
        mode,
        custom_prompt: customPrompt
      }
    );

    return response.data;
  } catch (error) {
    console.error('Text optimization failed:', error);
    throw error;
  }
}

export async function transcribeAndOptimize(audioBlob, options = {}) {
  const {
    useVad = true,
    usePunc = true,
    hotword = '',
    optimizeMode = 'optimize',
    intentMode = 'none',
    clientIntents = [],
    clientIntentConfidenceThreshold = 0.78,
  } = options;

  const formData = new FormData();
  formData.append('audio', audioBlob, inferAudioUploadFilename(audioBlob));
  formData.append('use_vad', useVad);
  formData.append('use_punc', usePunc);
  formData.append('hotword', hotword);
  formData.append('optimize_mode', optimizeMode);
  formData.append('intent_mode', intentMode);
  if (intentMode === 'client_intent') {
    formData.append('client_intents_json', JSON.stringify(Array.isArray(clientIntents) ? clientIntents : []));
    formData.append('client_intent_confidence_threshold', String(clientIntentConfidenceThreshold));
  }

  try {
    const response = await apiClient.post(
      `${await getBaseURL()}${backendConfig.endpoints.transcribeAndOptimize}`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Transcribe and optimize failed:', error);
    throw error;
  }
}

export async function getBackendStatus() {
  try {
    const response = await apiClient.get(`${await getBaseURL()}${backendConfig.endpoints.status}`);
    return response.data;
  } catch (error) {
    console.error('Failed to get backend status:', error);
    throw error;
  }
}

function normalizeTtsHealthPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;

  const speakerCandidates = [];
  if (Array.isArray(payload.tts_supported_speakers)) {
    speakerCandidates.push(...payload.tts_supported_speakers);
  }
  if (Array.isArray(payload.speakers)) {
    speakerCandidates.push(...payload.speakers);
  }
  if (Array.isArray(payload.workers)) {
    payload.workers.forEach((worker) => {
      if (Array.isArray(worker?.speakers)) {
        speakerCandidates.push(...worker.speakers);
      }
    });
  }

  const ttsSupportedSpeakers = Array.from(
    new Set(
      speakerCandidates
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((speaker) => TTS_SPEAKER_DISPLAY_NAMES[speaker.toLowerCase()] || speaker)
    )
  );
  const knownSpeakerKeys = new Set(QWEN3_TTS_CUSTOM_VOICE_SPEAKERS.map((speaker) => speaker.toLowerCase()));
  const normalizedSpeakerKeys = new Set(ttsSupportedSpeakers.map((speaker) => speaker.toLowerCase()));
  const orderedSpeakers = (
    knownSpeakerKeys.size === normalizedSpeakerKeys.size &&
    QWEN3_TTS_CUSTOM_VOICE_SPEAKERS.every((speaker) => normalizedSpeakerKeys.has(speaker.toLowerCase()))
  )
    ? QWEN3_TTS_CUSTOM_VOICE_SPEAKERS
    : ttsSupportedSpeakers;
  const firstWorker = Array.isArray(payload.workers) ? payload.workers.find(Boolean) : null;
  const defaultSpeaker = String(
    payload.tts_default_speaker || payload.default_speaker || firstWorker?.default_speaker || ''
  ).trim();
  const workersReady = extractTtsWorkerCount(payload, 8);
  const recommendedPrefetch = normalizePositiveInteger(
    payload.client_defaults?.recommended_prefetch_chunks,
    { low: 1, high: 8 }
  );

  return {
    ...payload,
    tts_default_speaker: TTS_SPEAKER_DISPLAY_NAMES[defaultSpeaker.toLowerCase()] || defaultSpeaker,
    tts_supported_speakers: orderedSpeakers,
    tts_supports_instruction: Boolean(payload.tts_supports_instruction),
    tts_parallel_workers_ready: workersReady || payload.tts_parallel_workers_ready,
    tts_workers_ready: workersReady || payload.tts_workers_ready,
    tts_recommended_prefetch_chunks: recommendedPrefetch || payload.tts_recommended_prefetch_chunks,
  };
}

export async function getTtsHealth() {
  try {
    const response = await apiClient.get(`${await getTtsBaseURL()}${backendConfig.endpoints.ttsHealth}`);
    return normalizeTtsHealthPayload(response.data);
  } catch (error) {
    console.error('Failed to get TTS health:', error);
    throw error;
  }
}

export async function getServiceStatus() {
  try {
    const response = await apiClient.get(`${await getBaseURL()}${backendConfig.endpoints.servicesStatus}`);
    return response.data;
  } catch (error) {
    console.error('Failed to get service status:', error);
    throw error;
  }
}

export async function healthCheck() {
  try {
    const response = await apiClient.get(`${await getBaseURL()}${backendConfig.endpoints.health}`);
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function speakText(text, options = {}) {
  const {
    language,
    speaker,
    instruction,
    speed = 1.0,
    traceId,
    maxNewTokens,
    signal: externalSignal
  } = options;

  const payload = {
    text,
    speed
  };
  if (language && String(language).trim()) {
    payload.language = String(language).trim();
  }
  if (speaker && String(speaker).trim()) {
    payload.speaker = String(speaker).trim();
  }
  if (instruction && String(instruction).trim()) {
    payload.instruction = String(instruction).trim();
  }
  if (traceId && String(traceId).trim()) {
    payload.trace_id = String(traceId).trim();
  }
  if (Number.isFinite(Number(maxNewTokens))) {
    payload.max_new_tokens = Number(maxNewTokens);
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TTS_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${await getTtsBaseURL()}${backendConfig.endpoints.ttsSpeak}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`TTS request timeout (${TTS_REQUEST_TIMEOUT_MS}ms)`);
      }
      throw new Error('TTS request aborted');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error || '';
    } catch (_) {
      detail = await response.text();
    }
    throw new Error(detail || `TTS request failed (${response.status})`);
  }

  const audioBlob = await response.blob();
  audioBlob.ttsDiagnostics = {
    workerId: response.headers.get('X-TTS-Worker-Id') || '',
    maxNewTokens: response.headers.get('X-TTS-Max-New-Tokens') || '',
    normalizer: response.headers.get('X-TTS-Normalizer') || '',
    hitTokenCap: response.headers.get('X-TTS-Hit-Token-Cap') || '',
    suspiciousDuration: response.headers.get('X-TTS-Suspicious-Duration') || '',
    audioSeconds: response.headers.get('X-TTS-Audio-Seconds') || '',
    elapsedSeconds: response.headers.get('X-TTS-Elapsed-Seconds') || '',
    rtf: response.headers.get('X-TTS-RTF') || ''
  };
  return audioBlob;
}

export async function translateText(text, target = 'zh', options = {}) {
  const { traceId, signal: externalSignal } = options;
  const sourceText = String(text || '').trim();
  if (!sourceText) {
    return {
      success: true,
      trace_id: traceId || null,
      source_text: '',
      translated_text: '',
      target,
      fallback: false,
      provider: 'empty'
    };
  }

  try {
    const translatedText = await translateTextWithServerLlm(sourceText, target, {
      timeoutMs: TRANSLATE_REQUEST_TIMEOUT_MS
    });
    return {
      success: true,
      trace_id: traceId || null,
      source_text: sourceText,
      translated_text: translatedText,
      target,
      fallback: false,
      provider: 'spark-server-llm'
    };
  } catch (serverLlmError) {
    console.warn('Server LLM translate failed, fallback to HTTP translate:', serverLlmError?.message || serverLlmError);
  }

  const requestPayload = {
    text: sourceText,
    target
  };
  if (traceId && String(traceId).trim()) {
    requestPayload.trace_id = String(traceId).trim();
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSLATE_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${await getBaseURL()}${backendConfig.endpoints.textTranslate}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`Translate request timeout (${TRANSLATE_REQUEST_TIMEOUT_MS}ms)`);
      }
      throw new Error('Translate request aborted');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }

  let responsePayload = null;
  try {
    responsePayload = await response.json();
  } catch (_) {
    responsePayload = null;
  }

  if (!response.ok) {
    throw new Error(responsePayload?.error || `Translate request failed (${response.status})`);
  }

  if (!responsePayload?.success) {
    throw new Error(responsePayload?.error || 'Translate failed');
  }

  return responsePayload;
}

export async function planTtsChunks(text, options = {}) {
  const {
    traceId,
    maxCharsPerChunk,
    langHint,
    signal: externalSignal
  } = options;

  const payload = { text };
  if (traceId && String(traceId).trim()) {
    payload.trace_id = String(traceId).trim();
  }
  if (Number.isFinite(maxCharsPerChunk)) {
    payload.max_chars_per_chunk = Number(maxCharsPerChunk);
  }
  if (langHint && String(langHint).trim()) {
    payload.lang_hint = String(langHint).trim();
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TTS_PLAN_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${await getTtsBaseURL()}${backendConfig.endpoints.ttsPlan}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`TTS plan request timeout (${TTS_PLAN_REQUEST_TIMEOUT_MS}ms)`);
      }
      throw new Error('TTS plan request aborted');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }

  let responsePayload = null;
  try {
    responsePayload = await response.json();
  } catch (_) {
    responsePayload = null;
  }

  if (!response.ok) {
    throw new Error(responsePayload?.error || `TTS plan request failed (${response.status})`);
  }
  if (!responsePayload?.success) {
    throw new Error(responsePayload?.error || 'TTS plan failed');
  }
  return responsePayload;
}

async function callTtsControl(endpointPath, options = {}) {
  const { signal: externalSignal } = options;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TTS_CONTROL_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${await getTtsBaseURL()}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}',
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`TTS control request timeout (${TTS_CONTROL_REQUEST_TIMEOUT_MS}ms)`);
      }
      throw new Error('TTS control request aborted');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || `TTS control request failed (${response.status})`);
  }
  if (!payload?.success) {
    throw new Error(payload?.error || 'TTS control failed');
  }
  return payload;
}

async function callServiceControl(endpointPath, options = {}) {
  const { signal: externalSignal } = options;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TTS_CONTROL_REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${await getBaseURL()}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}',
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`Service control request timeout (${TTS_CONTROL_REQUEST_TIMEOUT_MS}ms)`);
      }
      throw new Error('Service control request aborted');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Service control request failed (${response.status})`);
  }
  if (!payload?.success) {
    throw new Error(payload?.error || 'Service control failed');
  }
  return payload;
}

export async function loadTtsModel(options = {}) {
  return callTtsControl(backendConfig.endpoints.ttsLoad, options);
}

export async function unloadTtsModel(options = {}) {
  return callTtsControl(backendConfig.endpoints.ttsUnload, options);
}

export async function loadService(serviceName, options = {}) {
  return callServiceControl(backendConfig.endpoints.serviceLoad(serviceName), options);
}

export async function unloadService(serviceName, options = {}) {
  return callServiceControl(backendConfig.endpoints.serviceUnload(serviceName), options);
}

export default {
  transcribeAudio,
  transcribeAudioStream,
  isRealtimeASRConfigured,
  isHttpBackendConfigured,
  RealtimeASRSession,
  optimizeText,
  transcribeAndOptimize,
  getBackendStatus,
  getTtsHealth,
  getServiceStatus,
  healthCheck,
  speakText,
  translateText,
  planTtsChunks,
  loadTtsModel,
  unloadTtsModel,
  loadService,
  unloadService
};
