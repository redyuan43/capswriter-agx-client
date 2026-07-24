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

export function buildLatestPartialASRFallback(payload, reason = "") {
  if (!isUsableASRPayload(payload)) {
    return null;
  }
  const text = extractASRText(payload);
  return {
    ...payload,
    type: "final",
    success: true,
    final_text: text,
    text,
    asr_text: payload?.asr_text || payload?.text || payload?.partial_text || text,
    realtime_final_fallback: true,
    realtime_final_error: reason,
  };
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

export function shouldForceRealtimeUploadFallback(value) {
  return (
    value?.fallback === "upload" ||
    value?.realtimeFallback === "upload" ||
    value?.realtimePayload?.fallback === "upload"
  );
}

export function settleASRCandidate(source, promise) {
  return Promise.resolve(promise).then(
    (payload) => ({
      source,
      payload,
      error: null,
      usable: isUsableASRPayload(payload),
    }),
    (error) => ({
      source,
      payload: null,
      error,
      usable: false,
    })
  );
}

export async function waitForFirstUsableASRResult(resultPromises, options = {}) {
  const pending = resultPromises.map((resultPromise, index) => ({
    index,
    promise: Promise.resolve(resultPromise).then((result) => ({ index, result })),
  }));
  const settled = [];

  while (pending.length > 0) {
    const { index, result } = await Promise.race(pending.map((candidate) => candidate.promise));
    const pendingIndex = pending.findIndex((candidate) => candidate.index === index);
    if (pendingIndex >= 0) {
      pending.splice(pendingIndex, 1);
    }
    settled.push(result);
    options.onSettled?.(result);
    if (result?.usable) {
      return { winner: result, settled };
    }
  }

  return { winner: null, settled };
}
