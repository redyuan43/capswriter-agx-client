export const REALTIME_ASR_PROTOCOL = 'qwen3-asr-v1';
export const REALTIME_ASR_AUTH_PREFIX = 'auth.';

function cleanWebSocketUrl(value) {
  const url = String(value || '').trim();
  return /^wss?:\/\//i.test(url) ? url : '';
}

async function readSetting(getSetting, key, fallback) {
  if (typeof getSetting !== 'function') return fallback;
  try {
    return await getSetting(key, fallback);
  } catch {
    return fallback;
  }
}

export function buildRealtimeAsrProtocols(token) {
  const normalized = String(token || '').trim();
  if (!normalized) return [];
  return [REALTIME_ASR_PROTOCOL, `${REALTIME_ASR_AUTH_PREFIX}${normalized}`];
}

export async function resolveRealtimeAsrConnection({
  getSetting,
  defaultUrl,
  defaultFallbackUrl,
} = {}) {
  const primaryValue = await readSetting(getSetting, 'realtime_asr_url', defaultUrl);
  const tokenValue = await readSetting(getSetting, 'realtime_asr_token', '');
  const fallbackValue = await readSetting(
    getSetting,
    'realtime_asr_fallback_url',
    defaultFallbackUrl,
  );
  const primaryUrl = cleanWebSocketUrl(primaryValue) || cleanWebSocketUrl(defaultUrl);
  const fallbackUrl = cleanWebSocketUrl(fallbackValue);
  const token = String(tokenValue || '').trim();
  const candidates = [];
  if (primaryUrl) {
    candidates.push({ route: 'primary', url: primaryUrl, protocols: buildRealtimeAsrProtocols(token) });
  }
  if (fallbackUrl && fallbackUrl !== primaryUrl) {
    candidates.push({ route: 'fallback', url: fallbackUrl, protocols: [] });
  }
  return { primaryUrl, fallbackUrl, token, candidates };
}

export async function connectRealtimeAsrWithFallback(candidates, connectCandidate, onFallback) {
  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      return await connectCandidate(candidate);
    } catch (error) {
      lastError = error;
      if (index + 1 < candidates.length && typeof onFallback === 'function') {
        onFallback({ from: candidate.route, to: candidates[index + 1].route });
      }
    }
  }
  throw lastError || new Error('Realtime ASR websocket connection failed');
}
