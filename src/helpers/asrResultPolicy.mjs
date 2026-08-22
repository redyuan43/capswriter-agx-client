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

export function selectRealtimeFinalTimeoutFallback(error, latestPayload) {
  if (error?.code !== "REALTIME_ASR_FINAL_TIMEOUT" ||
      error?.realtimePayload || error?.realtimeReason) {
    return null;
  }
  return isUsableASRPayload(latestPayload)
    ? { ...latestPayload, partial_fallback: true }
    : null;
}

export function selectRealtimeStreamFailureFallback(error, latestPayload) {
  const reason = String(error?.realtimeReason || "");
  const message = String(error?.message || "");
  const streamInterrupted =
    reason === "audio_idle_without_finish" ||
    reason === "client_pcm_stalled" ||
    /audio stopped without finish or cancel/i.test(message);
  if (!streamInterrupted || !isUsableASRPayload(latestPayload)) {
    return null;
  }
  return {
    ...latestPayload,
    partial_fallback: true,
    partial_fallback_reason: reason || "realtime_stream_interrupted",
  };
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
