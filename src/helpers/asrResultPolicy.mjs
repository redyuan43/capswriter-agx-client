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

/**
 * 设备侧音频上传中断后的抢救取词。
 *
 * 场景（2026-09-20 实测）：M5 说了 45 秒，前 33 秒音频正常，设备在 stop
 * 请求里报 upload_failed。此时实时识别其实已经转出 173 字，但主进程原来
 * 直接发 cancel，渲染层连文本带 PCM 一起扔了，用户说完一整段什么也没有。
 *
 * 现在主进程改发带 salvage 标记的 stop，渲染层用这个函数取最近一次 partial
 * 当结果，走正常的粘贴/留存链路。**不做任何"等 final"的尝试**：设备已经
 * 不再上传音频，等下去只会拖到超时。
 */
export function selectSalvagePayload(latestPayload, reason = "device_upload_failed") {
  if (!isUsableASRPayload(latestPayload)) {
    return null;
  }
  return {
    ...latestPayload,
    partial_fallback: true,
    partial_fallback_reason: `salvage:${reason}`,
  };
}
