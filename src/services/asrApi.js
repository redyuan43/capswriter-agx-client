import backendConfig from '../config/backend.js';
import { apiClient, getBaseURL, inferAudioUploadFilename } from './sharedClient.js';

export async function transcribeAudio(audioBlob, options = {}) {
  const { useVad = true, usePunc = true, hotword = '' } = options;
  const formData = new FormData();
  formData.append('audio', audioBlob, inferAudioUploadFilename(audioBlob));
  formData.append('use_vad', useVad);
  formData.append('use_punc', usePunc);
  formData.append('hotword', hotword);

  const response = await apiClient.post(`${await getBaseURL()}${backendConfig.endpoints.transcribe}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return response.data;
}

export async function transcribeAudioStream(audioBlob, options = {}) {
  const { useVad = true, usePunc = true, hotword = '', optimizeMode = 'none', translateTarget = 'zh', onEvent = null } = options;
  const formData = new FormData();
  formData.append('audio', audioBlob, inferAudioUploadFilename(audioBlob));
  formData.append('use_vad', useVad);
  formData.append('use_punc', usePunc);
  formData.append('hotword', hotword);
  formData.append('optimize_mode', optimizeMode);
  if ((optimizeMode || '').toLowerCase() === 'translate') {
    formData.append('translate_target', translateTarget || 'zh');
  }

  const response = await fetch(`${await getBaseURL()}${backendConfig.endpoints.transcribeAndOptimizeStream}`, {
    method: 'POST',
    body: formData,
    headers: { Accept: 'text/event-stream' }
  });

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

  const handlePayload = payload => {
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
    const { value, done } = await reader.read();
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
        handlePayload(JSON.parse(dataStr));
      } catch (error) {
        console.warn('[API] Ignore malformed SSE payload:', error);
      }
    }
  }

  const rest = buffer.trim();
  if (rest.startsWith('data:')) {
    const dataStr = rest.slice(5).trim();
    if (dataStr) {
      handlePayload(JSON.parse(dataStr));
    }
  }

  if (!finalPayload) {
    throw new Error('Stream finished without done event');
  }
  return finalPayload;
}

export async function optimizeText(text, mode = 'optimize', customPrompt = null) {
  const response = await apiClient.post(`${await getBaseURL()}${backendConfig.endpoints.optimize}`, {
    text,
    mode,
    custom_prompt: customPrompt
  });
  return response.data;
}

export async function transcribeAndOptimize(audioBlob, options = {}) {
  const { useVad = true, usePunc = true, hotword = '', optimizeMode = 'optimize' } = options;
  const formData = new FormData();
  formData.append('audio', audioBlob, inferAudioUploadFilename(audioBlob));
  formData.append('use_vad', useVad);
  formData.append('use_punc', usePunc);
  formData.append('hotword', hotword);
  formData.append('optimize_mode', optimizeMode);

  const response = await apiClient.post(`${await getBaseURL()}${backendConfig.endpoints.transcribeAndOptimize}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return response.data;
}

export async function getBackendStatus() {
  const response = await apiClient.get(`${await getBaseURL()}${backendConfig.endpoints.status}`);
  return response.data;
}

export async function healthCheck() {
  try {
    const response = await apiClient.get(`${await getBaseURL()}${backendConfig.endpoints.health}`);
    return response.status === 200;
  } catch {
    return false;
  }
}
