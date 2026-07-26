export function extractASRText(payload) {
  return String(
    payload?.final_text ||
    payload?.translated_text ||
    payload?.optimized_text ||
    payload?.asr_text ||
    payload?.text ||
    payload?.partial_text ||
    ""
  ).trim();
}

export function isUsableASRPayload(payload) {
  if (!payload || payload.success === false) {
    return false;
  }
  return Boolean(extractASRText(payload) || payload.voice_command_applied === true);
}

export function createRealtimeProtocolError(payload, fallbackMessage) {
  const error = new Error(
    payload?.error ||
    payload?.message ||
    fallbackMessage
  );
  error.realtimeReason = String(payload?.reason || "");
  error.realtimeFallback = String(payload?.fallback || "");
  error.realtimePayload = payload || null;
  return error;
}
