import backendConfig from '../config/backend.js';
import {
  TTS_CONTROL_REQUEST_TIMEOUT_MS,
  TTS_PLAN_REQUEST_TIMEOUT_MS,
  TTS_REQUEST_TIMEOUT_MS,
  callJsonControl,
  getTtsBaseURL
} from './sharedClient.js';

export async function speakText(text, options = {}) {
  const { language, speaker, instruction, speed = 1.0, traceId, maxNewTokens, signal: externalSignal } = options;
  const payload = { text, speed };
  if (language && String(language).trim()) payload.language = String(language).trim();
  if (speaker && String(speaker).trim()) payload.speaker = String(speaker).trim();
  if (instruction && String(instruction).trim()) payload.instruction = String(instruction).trim();
  if (traceId && String(traceId).trim()) payload.trace_id = String(traceId).trim();
  if (Number.isFinite(Number(maxNewTokens))) payload.max_new_tokens = Number(maxNewTokens);

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) throw new Error(`TTS request timeout (${TTS_REQUEST_TIMEOUT_MS}ms)`);
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

export async function planTtsChunks(text, options = {}) {
  const { traceId, maxCharsPerChunk, langHint, signal: externalSignal } = options;
  const payload = { text };
  if (traceId && String(traceId).trim()) payload.trace_id = String(traceId).trim();
  if (Number.isFinite(maxCharsPerChunk)) payload.max_chars_per_chunk = Number(maxCharsPerChunk);
  if (langHint && String(langHint).trim()) payload.lang_hint = String(langHint).trim();

  return callJsonControl(backendConfig.endpoints.ttsPlan, TTS_PLAN_REQUEST_TIMEOUT_MS, 'TTS plan request', {
    signal: externalSignal,
    body: JSON.stringify(payload),
    useTtsBaseURL: true
  });
}

export async function loadTtsModel(options = {}) {
  return callJsonControl(backendConfig.endpoints.ttsLoad, TTS_CONTROL_REQUEST_TIMEOUT_MS, 'TTS control request', {
    ...options,
    useTtsBaseURL: true
  });
}

export async function unloadTtsModel(options = {}) {
  return callJsonControl(backendConfig.endpoints.ttsUnload, TTS_CONTROL_REQUEST_TIMEOUT_MS, 'TTS control request', {
    ...options,
    useTtsBaseURL: true
  });
}
