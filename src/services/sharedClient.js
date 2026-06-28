import axios from 'axios';
import backendConfig from '../config/backend.js';

export const TTS_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TTS_REQUEST_TIMEOUT_MS || 120000);
export const TRANSLATE_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TRANSLATE_REQUEST_TIMEOUT_MS || 20000);
export const TTS_PLAN_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TTS_PLAN_REQUEST_TIMEOUT_MS || 10000);
export const TTS_CONTROL_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_TTS_CONTROL_REQUEST_TIMEOUT_MS || 10000);

export const apiClient = axios.create({
  timeout: backendConfig.timeout,
  headers: {
    'Content-Type': 'application/json'
  }
});

export async function getBaseURL() {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.getSetting) {
      const url = await window.electronAPI.getSetting('backend_url', backendConfig.baseURL);
      if (url && typeof url === 'string' && url.trim()) {
        return url.trim();
      }
    }
  } catch {
    // Silently fallback
  }
  return backendConfig.baseURL;
}

export async function getTtsBaseURL() {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.getSetting) {
      const url = await window.electronAPI.getSetting('tts_base_url', backendConfig.ttsBaseURL);
      if (url && typeof url === 'string' && url.trim()) {
        return url.trim();
      }
    }
  } catch {
    // Silently fallback
  }
  return backendConfig.ttsBaseURL;
}

apiClient.interceptors.request.use(
  config => config,
  error => Promise.reject(error)
);

apiClient.interceptors.response.use(
  response => response,
  error => {
    console.error('[API] Error:', error.message);
    return Promise.reject(error);
  }
);

export function inferAudioUploadFilename(audioBlob) {
  const mimeType = (audioBlob?.type || '').toLowerCase();
  if (mimeType.includes('webm')) return 'audio.webm';
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('wav')) return 'audio.wav';
  return 'audio.bin';
}

export async function callJsonControl(endpointPath, timeoutMs, label, options = {}) {
  const { signal: externalSignal, body = '{}', useTtsBaseURL = false } = options;
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
  }, timeoutMs);

  let response;
  try {
    const baseURL = useTtsBaseURL ? await getTtsBaseURL() : await getBaseURL();
    response = await fetch(`${baseURL}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`${label} timeout (${timeoutMs}ms)`);
      }
      throw new Error(`${label} aborted`);
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
    throw new Error(payload?.error || `${label} failed (${response.status})`);
  }
  if (!payload?.success) {
    throw new Error(payload?.error || `${label} failed`);
  }
  return payload;
}
