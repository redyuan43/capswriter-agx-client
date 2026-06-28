import backendConfig from '../config/backend.js';
import { TRANSLATE_REQUEST_TIMEOUT_MS, getBaseURL } from './sharedClient.js';

export async function translateText(text, target = 'zh', options = {}) {
  const { traceId, signal: externalSignal } = options;
  const requestPayload = { text, target };
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) throw new Error(`Translate request timeout (${TRANSLATE_REQUEST_TIMEOUT_MS}ms)`);
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
