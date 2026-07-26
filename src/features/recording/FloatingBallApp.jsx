import { useState, useEffect, useRef, useCallback } from "react";
import "../../floating-ball.css";
import appLogoUrl from "../../../assets/icon.png?url";
import codexCompletionChimeUrl from "../../assets/audio/codex-complete.oga?url";
import { useRecording } from "../../hooks/useRecording";
import { useModelStatus } from "../../hooks/useModelStatus";
import {
  ExternalPCMRealtimeSession,
  computeRealtimeASRFinalTimeoutMs,
  isRealtimeASRConfigured,
  planTtsChunks,
  speakText,
  translateText,
  loadTtsModel,
  unloadTtsModel,
  loadService,
  unloadService,
  isHttpBackendConfigured,
  learnHotwords,
} from "../../services/backendAPI.js";
import { isExactSilentASRArtifactText } from "../../helpers/silentAsrArtifacts.js";
import {
  extractASRText,
  isUsableASRPayload,
} from "../../helpers/asrResultPolicy.mjs";

const SETTING_VOICE_TRANSLATE_MODE = "voice_translate_mode";
const SETTING_VOICE_TRANSLATE_TARGET = "voice_translate_target";
const SETTING_VOICE_TTS_ENABLED = "voice_tts_enabled";
const SETTING_VOICE_TTS_SPEED = "voice_tts_speed";
const SETTING_VOICE_TTS_SPEAKER = "voice_tts_speaker";
const SETTING_VOICE_TTS_INSTRUCTION = "voice_tts_instruction";
const SETTING_VOICE_RELEASE_GRACE_MS = "voice_release_grace_ms";
const SETTING_VOICE_FAST_INPUT_MODE = "voice_fast_input_mode";
const DEFAULT_VOICE_RELEASE_GRACE_MS = 300;
const SETTING_CAPS_MIN_HOLD_MS = "caps_min_hold_ms";
const DEFAULT_CAPS_MIN_HOLD_MS = 150;
const DICTATION_CONTROL_STATUSES = ["recording", "processing", "preview_ready", "pasting", "optimizing"];
const CODEX_FLOATING_PREVIEW_MAX_CHARS = 420;
const CODEX_COMPLETION_CHIME_COOLDOWN_MS = 1200;
function normalizeExternalRecordingMode(value) {
  const normalized = String(value || "dictation").trim().toLowerCase().replace(/-/g, "_");
  if (["cyber_fortune", "fortune", "fort"].includes(normalized)) return "cyber_fortune";
  if (["cyber_almanac", "almanac", "huangli", "alm"].includes(normalized)) return "cyber_almanac";
  return "dictation";
}

function isCyberRecordingMode(mode) {
  return ["cyber_fortune", "cyber_almanac"].includes(String(mode || ""));
}

function isCodexPreviewNoiseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return true;
  if (/^[\d;?]+[A-Za-z]?$/.test(trimmed)) return true;
  if (/^[─━_\-=]{4,}$/.test(trimmed)) return true;
  if ((trimmed.match(/Working/gi) || []).length >= 2) return true;
  if (/^\d*H?\d*(?:Working|orking|rking|king|inging|ng){2,}/i.test(trimmed)) return true;
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length >= 20) {
    const startupFragments = (compact.toLowerCase().match(/starting|start|mcp|servers?|serv|codex|code/g) || []).length;
    if (startupFragments >= 3) return true;
    if (/start(?:ing)?(?:start(?:ing)?){1,}/i.test(compact)) return true;
  }
  if (/^(?:q|x|j|k|l|m|n|t|u|v|w|`|a|:|;|\s)+$/i.test(trimmed)) return true;
  if ((trimmed.match(/\b\d{1,3};\d{1,3}[A-Za-z]\b/g) || []).length >= 2) return true;
  if (/^[|>]+\s*/.test(trimmed)) return true;
  if (/^```/.test(trimmed)) return true;
  if (/^(?:if|then|else|fi|for|while|do|done|case|esac)\b/.test(trimmed)) return true;
  if (/\b(?:pactl|set-sink-volume|set-sink-mute|get-sink-volume|awk|grep|sed|xargs|sudo|bash|sh|python|node|npm|systemctl|journalctl|curl|ssh|git)\b/.test(trimmed)) return true;
  if (/\b(?:front-left|front-right|Volume:|Sink #|RUNNING|IDLE)\b/i.test(trimmed)) return true;
  return false;
}

function sanitizeCodexFloatingPreview(value) {
  const cleaned = String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isCodexPreviewNoiseLine(line))
    .slice(-4)
    .join("\n")
    .trim();

  if (!cleaned) return "";
  return cleaned.length > CODEX_FLOATING_PREVIEW_MAX_CHARS
    ? `${cleaned.slice(0, CODEX_FLOATING_PREVIEW_MAX_CHARS)}...`
    : cleaned;
}
const DEFAULT_TTS_SPEED = 1.0;
const DEFAULT_TTS_SPEAKER = "";
const AUTO_TTS_CHINESE_SPEAKER = "Serena";
const AUTO_TTS_ENGLISH_SPEAKER = "Ryan";
const DEFAULT_TTS_INSTRUCTION = "";
const CLIPBOARD_SELF_WRITE_SUPPRESS_MS = 1800;
const TTS_PREFETCH_WINDOW_ENV = String(import.meta.env.VITE_TTS_PREFETCH_WINDOW || "auto").trim().toLowerCase();
const TTS_REMOTE_PREFETCH_WINDOW_ENV = String(import.meta.env.VITE_TTS_REMOTE_PREFETCH_WINDOW || "auto").trim().toLowerCase();
const DEFAULT_TTS_PLAN_MAX_CHARS = Math.max(10, Number(import.meta.env.VITE_TTS_PLAN_MAX_CHARS || 50));
const REMOTE_TTS_PLAN_MAX_CHARS = Math.max(
  10,
  Math.min(DEFAULT_TTS_PLAN_MAX_CHARS, Number(import.meta.env.VITE_TTS_REMOTE_PLAN_MAX_CHARS || 45))
);
const TTS_MAX_NEW_TOKENS_ENV = String(import.meta.env.VITE_TTS_MAX_NEW_TOKENS || "auto").trim().toLowerCase();
const TTS_TOKEN_RATE_HZ = Number.isFinite(Number(import.meta.env.VITE_TTS_TOKEN_RATE_HZ))
  ? Math.max(6, Math.min(30, Number(import.meta.env.VITE_TTS_TOKEN_RATE_HZ)))
  : 12;
const TTS_SPEECH_CHARS_PER_SECOND = Number.isFinite(Number(import.meta.env.VITE_TTS_CHARS_PER_SECOND))
  ? Math.max(2.5, Math.min(8, Number(import.meta.env.VITE_TTS_CHARS_PER_SECOND)))
  : 5;
const TTS_ABNORMAL_AUDIO_MIN_SECONDS = Math.max(8, Number(import.meta.env.VITE_TTS_ABNORMAL_AUDIO_MIN_SECONDS || 12));
const TTS_ABNORMAL_AUDIO_EXTRA_SECONDS = Math.max(0, Number(import.meta.env.VITE_TTS_ABNORMAL_AUDIO_EXTRA_SECONDS || 8));
const TTS_ABNORMAL_AUDIO_CJK_SECONDS = Math.max(0.1, Number(import.meta.env.VITE_TTS_ABNORMAL_AUDIO_CJK_SECONDS || 0.45));
const TTS_ABNORMAL_AUDIO_WORD_SECONDS = Math.max(0.1, Number(import.meta.env.VITE_TTS_ABNORMAL_AUDIO_WORD_SECONDS || 0.5));
const TYPEWRITER_DELETE_STEP_MS = 22;
const TYPEWRITER_TYPE_STEP_MS = 17;
const TYPEWRITER_MIN_STEP_MS = 9;
const TYPEWRITER_MAX_STEP_MS = 36;
const TYPEWRITER_DELETE_SPEED_RATIO = 0.72;
const TYPEWRITER_FAST_DELETE_MULTIPLIER = 0.5;
const TYPEWRITER_FAST_DELETE_THRESHOLD = 6;
const REVISION_STEP_SPEED_RATIO = 2;
const REVISION_MAX_TOKENS = 420;

function isAllEnglishTtsText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  let latinCount = 0;
  let cjkCount = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      cjkCount += 1;
    } else if (/[A-Za-z]/.test(char)) {
      latinCount += 1;
    }
  }
  return latinCount > 0 && cjkCount === 0;
}

function resolveTtsRequestVoice(text, manualSpeaker) {
  const language = isAllEnglishTtsText(text) ? "English" : "Chinese";
  const requestedSpeaker = String(manualSpeaker || "").trim();
  return {
    language,
    speaker: requestedSpeaker || (language === "English" ? AUTO_TTS_ENGLISH_SPEAKER : AUTO_TTS_CHINESE_SPEAKER)
  };
}

function estimateTtsAllowedSeconds(text) {
  const source = String(text || "").trim();
  const cjkCount = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWordCount = (source.match(/[A-Za-z0-9]+(?:[-_'][A-Za-z0-9]+)*/g) || []).length;
  const estimatedSeconds =
    cjkCount * TTS_ABNORMAL_AUDIO_CJK_SECONDS +
    latinWordCount * TTS_ABNORMAL_AUDIO_WORD_SECONDS +
    TTS_ABNORMAL_AUDIO_EXTRA_SECONDS;
  return Math.max(TTS_ABNORMAL_AUDIO_MIN_SECONDS, estimatedSeconds);
}

function clampTtsMaxNewTokens(value) {
  if (!Number.isFinite(Number(value))) return null;
  const tokens = Math.floor(Number(value));
  if (tokens <= 0) return null;
  return Math.max(32, Math.min(512, tokens));
}

function positiveInteger(value, { low = 1, high = 8 } = {}) {
  if (!Number.isFinite(Number(value))) return null;
  const integer = Math.floor(Number(value));
  if (integer < low) return null;
  return Math.max(low, Math.min(high, integer));
}

function resolveTtsPrefetchWindow(modelStatus, isRemoteTts) {
  const fixedRemote = isRemoteTts ? positiveInteger(TTS_REMOTE_PREFETCH_WINDOW_ENV, { low: 1, high: 8 }) : null;
  if (fixedRemote) return fixedRemote;
  const fixedDefault = positiveInteger(TTS_PREFETCH_WINDOW_ENV, { low: 1, high: 8 });
  if (fixedDefault) return fixedDefault;
  const recommended = positiveInteger(modelStatus?.ttsRecommendedPrefetch, { low: 1, high: 8 });
  if (recommended) return recommended;
  const workersReady = positiveInteger(modelStatus?.ttsWorkersReady, { low: 1, high: 8 });
  if (workersReady) return Math.max(1, Math.min(5, workersReady + 1));
  return isRemoteTts ? 3 : 2;
}

function estimateTtsMaxNewTokens(text) {
  const fixed = clampTtsMaxNewTokens(TTS_MAX_NEW_TOKENS_ENV);
  if (fixed) return fixed;
  const chars = String(text || "").replace(/\s+/g, "").length;
  const expectedSeconds = Math.max(2.5, Math.min(18, (chars / TTS_SPEECH_CHARS_PER_SECOND) + 1.5));
  return Math.max(48, Math.min(240, Math.ceil(expectedSeconds * TTS_TOKEN_RATE_HZ)));
}

async function estimateAudioBlobDurationSeconds(audioBlob) {
  if (!audioBlob || typeof audioBlob.arrayBuffer !== "function") return null;
  const buffer = await audioBlob.arrayBuffer();
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  const readAscii = (offset, length) => {
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(view.getUint8(offset + index));
    }
    return value;
  };
  if (readAscii(0, 4) !== "RIFF" || readAscii(8, 4) !== "WAVE") return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && chunkDataOffset + 16 <= buffer.byteLength) {
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond || !dataBytes) return null;
  return dataBytes / bytesPerSecond;
}

function segmentRevisionText(text) {
  const normalized = String(text || "");
  if (!normalized) return [];

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
      const segments = Array.from(segmenter.segment(normalized), item => item.segment);
      if (segments.length > 0) return segments;
    } catch {
      // Fall through to regex segmentation.
    }
  }

  return normalized.match(/[\u3400-\u9fff]|[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*|\s+|[^\s]/gu) || [];
}

function buildRevisionParts(previousText, nextText, revisionId) {
  const oldTokens = segmentRevisionText(previousText);
  const newTokens = segmentRevisionText(nextText);
  if (
    oldTokens.length === 0 ||
    newTokens.length === 0 ||
    oldTokens.length + newTokens.length > REVISION_MAX_TOKENS
  ) {
    return null;
  }

  const rows = oldTokens.length + 1;
  const cols = newTokens.length + 1;
  const table = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      table[i][j] = oldTokens[i] === newTokens[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const parts = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
    if (
      oldIndex < oldTokens.length &&
      newIndex < newTokens.length &&
      oldTokens[oldIndex] === newTokens[newIndex]
    ) {
      parts.push({ text: oldTokens[oldIndex], type: "stable" });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex >= newTokens.length ||
      (oldIndex < oldTokens.length && table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1])
    ) {
      parts.push({ text: oldTokens[oldIndex], type: "removed" });
      oldIndex += 1;
    } else {
      parts.push({ text: newTokens[newIndex], type: "added" });
      newIndex += 1;
    }
  }

  if (!parts.some(part => part.type !== "stable")) return null;

  return parts.map((part, index) => ({
    ...part,
    displayText: part.type === "added" ? "" : part.text,
    key: `${revisionId}-${index}-${part.type}`,
  }));
}

function sliceByCharacters(text, count) {
  return Array.from(String(text || "")).slice(0, Math.max(0, count)).join("");
}

function payloadToArrayBuffer(chunk) {
  if (!chunk) return new ArrayBuffer(0);
  if (chunk instanceof ArrayBuffer) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  }
  return new Uint8Array(chunk).buffer;
}

function concatArrayBuffers(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function writeAscii(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function createWavBlobFromPCM(chunks, sampleRate = 16000) {
  const pcm = concatArrayBuffers(chunks);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const bytesPerSample = 2;
  const channels = 1;
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: "audio/wav" });
}

function computePCMStats(chunks, sampleRate = 16000) {
  const pcm = concatArrayBuffers(chunks);
  const view = new DataView(pcm);
  const sampleCount = Math.floor(pcm.byteLength / 2);
  let peakAbs = 0;
  let sumSquares = 0;
  let activeSamples = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    const abs = Math.abs(sample);
    if (abs > peakAbs) peakAbs = abs;
    sumSquares += sample * sample;
    if (abs >= 0.0025) activeSamples += 1;
  }
  const durationSec = sampleRate > 0 ? sampleCount / sampleRate : 0;
  return {
    sampleRate,
    chunkCount: chunks.length,
    totalSamples: sampleCount,
    durationMs: Math.round(durationSec * 1000),
    durationSec: Number(durationSec.toFixed(3)),
    bufferSize: pcm.byteLength,
    peakAbs: Number(peakAbs.toFixed(6)),
    rms: sampleCount ? Number(Math.sqrt(sumSquares / sampleCount).toFixed(6)) : 0,
    activeSamples,
    activeRatio: sampleCount ? Number((activeSamples / sampleCount).toFixed(6)) : 0,
  };
}

function normalizeASRPayload(payload, wavBlob) {
  const text = extractASRText(payload);
  return {
    success: payload?.success !== false,
    text,
    asr_text: payload?.asr_text || payload?.text || text,
    raw_asr_text: payload?.raw_asr_text || "",
    duration: payload?.duration || payload?.timing?.audio_duration_s || 0,
    language: payload?.language || "zh-CN",
    confidence: payload?.confidence || 0.95,
    request_id: payload?.request_id,
    audio_stats: payload?.audio_stats || null,
    postprocess_mode: payload?.postprocess_mode || "none",
    translation_success: payload?.translation_success,
    translation_error: payload?.translation_error,
    voice_command_applied: payload?.voice_command_applied === true,
    voice_command_type: payload?.voice_command_type || "",
    voice_command_phrase: payload?.voice_command_phrase || "",
    voice_command_source: payload?.voice_command_source || "",
    voice_command_confidence: payload?.voice_command_confidence,
    voice_intent_id: payload?.voice_intent_id || "",
    voice_intent_source: payload?.voice_intent_source || "",
    voice_intent_confidence: payload?.voice_intent_confidence,
    voice_intent_reason: payload?.voice_intent_reason || "",
    voice_intent_action_type: payload?.voice_intent_action_type || "",
    file_size: wavBlob?.size || 0,
  };
}

export default function FloatingBallApp() {
  const [realtimeText, setRealtimeText] = useState("");
  const [displayedRealtimeText, setDisplayedRealtimeText] = useState("");
  const [revisionParts, setRevisionParts] = useState([]);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [coldStartLoading, setColdStartLoading] = useState(false);
  const [initialLoadingReason, setInitialLoadingReason] = useState(null);
  const [loadingElapsedSec, setLoadingElapsedSec] = useState(null);
  const [translateMode, setTranslateMode] = useState("transcribe");
  const [translateTarget, setTranslateTarget] = useState("zh");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [, setTtsSpeed] = useState(DEFAULT_TTS_SPEED);
  const [, setTtsSpeaker] = useState(DEFAULT_TTS_SPEAKER);
  const [, setTtsInstruction] = useState(DEFAULT_TTS_INSTRUCTION);
  const [ttsControlSyncReady, setTtsControlSyncReady] = useState(false);
  const [voiceReleaseGraceMs, setVoiceReleaseGraceMs] = useState(DEFAULT_VOICE_RELEASE_GRACE_MS);
  const [, setFastInputMode] = useState(true);
  const wrapperRef = useRef(null);
  const recognizedTextRef = useRef(null);
  const lastStatusAtRef = useRef(Date.now());
  const MIN_STAGE_DURATION_MS = 250;
  const lastClipboardTextRef = useRef("");
  const ttsEnabledRef = useRef(false);
  const ttsSpeedRef = useRef(DEFAULT_TTS_SPEED);
  const ttsSpeakerRef = useRef(DEFAULT_TTS_SPEAKER);
  const ttsInstructionRef = useRef(DEFAULT_TTS_INSTRUCTION);
  const ttsAudioRef = useRef(null);
  const ttsObjectUrlRef = useRef(null);
  const ttsPlaybackCancelRef = useRef(null);
  const ttsRequestIdRef = useRef(0);
  const ttsAbortControllersRef = useRef(new Set());
  const ttsControlEffectInitializedRef = useRef(false);
  const translateModeRef = useRef("transcribe");
  const fastInputModeRef = useRef(true);
  const pendingStopTimerRef = useRef(null);
  const isRecordingRef = useRef(false);
  const recordingModeRef = useRef("dictation");
  const codexUpdateHideTimerRef = useRef(null);
  const codexSubmitInFlightRef = useRef(false);
  const codexChimeAudioRef = useRef(null);
  const codexLastChimeAtRef = useRef(0);
  const voiceLearningCandidateRef = useRef(null);
  const voiceLearningHideTimerRef = useRef(null);
  const sessionHotwordsRef = useRef([]);
  const statusRef = useRef("idle");
  const outputControlRef = useRef({ generation: 0, interrupted: false, reason: "" });
  const pendingDictationConfirmRef = useRef(false);
  const stopRequestSeqRef = useRef(0);
  const suppressClipboardUntilRef = useRef(0);
  const displayedRealtimeTextRef = useRef("");
  const displayTargetTextRef = useRef("");
  const typewriterTimerRef = useRef(null);
  const revisionTimerRef = useRef(null);
  const loadingTimerRef = useRef(null);
  const loadingStartedAtRef = useRef(0);
  const loadingReasonRef = useRef(null);
  const revisionSeqRef = useRef(0);
  const typewriterStepMsRef = useRef(TYPEWRITER_TYPE_STEP_MS);
  const lastAnimatedTargetAtRef = useRef(0);
  const lastAnimatedTargetTextRef = useRef("");
  const externalRecordingRef = useRef(null);
  const externalPCMChunksRef = useRef([]);
  const externalRealtimeSessionRef = useRef(null);
  const TTS_CHUNK_RETRY = 1;
  const TTS_FAIL_STOP_THRESHOLD = 3;

  const modelStatus = useModelStatus();
  const isRemoteTts = modelStatus.ttsRemoteService === true;
  const ttsWorkersReady = modelStatus.ttsWorkersReady;
  const ttsRecommendedPrefetch = modelStatus.ttsRecommendedPrefetch;
  const ttsPrefetchWindow = resolveTtsPrefetchWindow(modelStatus, isRemoteTts);
  const ttsPlanMaxChars = isRemoteTts ? REMOTE_TTS_PLAN_MAX_CHARS : DEFAULT_TTS_PLAN_MAX_CHARS;

  const {
    isRecording,
    isProcessing: isRecordingProcessing,
    isOptimizing,
    startRecording,
    stopRecording,
    cancelRecording,
    error: recordingError
  } = useRecording({ translateMode, translateTarget });

  const lastPasteRef = useRef({ text: '', timestamp: 0 });
  const PASTE_DEBOUNCE_TIME = 1000;

  const normalizeReleaseGraceMs = useCallback((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_VOICE_RELEASE_GRACE_MS;
    return Math.min(1000, Math.max(0, Math.round(parsed)));
  }, []);

  const normalizeTtsSpeed = useCallback((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_TTS_SPEED;
    return Math.min(2, Math.max(0.5, Math.round(parsed * 10) / 10));
  }, []);

  const transitionStatus = useCallback((nextStatus) => {
    const now = Date.now();
    const elapsed = now - lastStatusAtRef.current;
    const delay = Math.max(0, MIN_STAGE_DURATION_MS - elapsed);

    return new Promise((resolve) => {
      setTimeout(() => {
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        lastStatusAtRef.current = Date.now();
        resolve();
      }, delay);
    });
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const isCurrentOutputGeneration = (generation, options = {}) => {
    const allowInterrupted = Boolean(options.allowInterruptedConfirm);
    if (allowInterrupted && outputControlRef.current.interrupted && outputControlRef.current.reason === "confirm") {
      return outputControlRef.current.generation === generation;
    }

    return !outputControlRef.current.interrupted && outputControlRef.current.generation === generation;
  };

  const playCodexCompletionChime = useCallback(() => {
    const now = Date.now();
    if (now - codexLastChimeAtRef.current < CODEX_COMPLETION_CHIME_COOLDOWN_MS) return;
    codexLastChimeAtRef.current = now;

    try {
      const audio = codexChimeAudioRef.current || new Audio(codexCompletionChimeUrl);
      codexChimeAudioRef.current = audio;
      audio.src = codexCompletionChimeUrl;
      audio.preload = "auto";
      audio.volume = 1;
      audio.currentTime = 0;
      audio.play()
        .then(() => {
          window.electronAPI?.log?.("info", "Codex completion chime played with HTMLAudioElement").catch(() => { });
        })
        .catch((error) => {
          window.electronAPI?.log?.("warn", "Failed to play Codex completion chime with HTMLAudioElement", {
            error: error?.message || String(error),
          }).catch(() => { });
        });
    } catch (error) {
      window.electronAPI?.log?.("warn", "Failed to prepare Codex completion chime", {
        error: error?.message || String(error),
      }).catch(() => { });
    }
  }, []);

  useEffect(() => {
    return () => {
      codexChimeAudioRef.current = null;
    };
  }, []);

  const safePaste = useCallback(async (text, expectedGeneration = outputControlRef.current.generation) => {
    const allowInterruptedConfirm =
      outputControlRef.current.interrupted && outputControlRef.current.reason === "confirm";

    if (
      outputControlRef.current.interrupted &&
      outputControlRef.current.reason !== "confirm"
    ) {
      return { ok: false, mode: "cancelled" };
    }

    if (!isCurrentOutputGeneration(expectedGeneration, {
      allowInterruptedConfirm,
    })) {
      return { ok: false, mode: "cancelled" };
    }

    const now = Date.now();
    const lastPaste = lastPasteRef.current;

    if (lastPaste.text === text && (now - lastPaste.timestamp) < PASTE_DEBOUNCE_TIME) {
      return { ok: true, mode: "skipped" };
    }

    lastPasteRef.current = { text, timestamp: now };
    suppressClipboardUntilRef.current = now + CLIPBOARD_SELF_WRITE_SUPPRESS_MS;

    if (!isCurrentOutputGeneration(expectedGeneration, {
      allowInterruptedConfirm,
    })) {
      return { ok: false, mode: "cancelled" };
    }

    try {
      if (window.electronAPI) {
        const pasteResult = await window.electronAPI.pasteText(text);
        if (pasteResult && pasteResult.success === false) {
          return { ok: false, mode: "failed" };
        }
        return { ok: true, mode: "pasted" };
      } else {
        await navigator.clipboard.writeText(text);
        return { ok: true, mode: "copied" };
      }
    } catch (error) {
      console.error("粘贴失败:", error);
      return { ok: false, mode: "failed" };
    }
  }, []);

  const hideFloatingBall = useCallback(() => {
    if (window.electronAPI && window.electronAPI.hideFloatingBall) {
      window.electronAPI.hideFloatingBall().catch(() => { });
    }
  }, []);

  const resizeFloatingBall = useCallback((width, height) => {
    if (window.electronAPI && window.electronAPI.resizeFloatingBall) {
      window.electronAPI.resizeFloatingBall(width, height).catch(() => { });
    }
  }, []);

  const stopTypewriterAnimation = useCallback(() => {
    if (typewriterTimerRef.current) {
      clearTimeout(typewriterTimerRef.current);
      typewriterTimerRef.current = null;
    }
    if (revisionTimerRef.current) {
      clearTimeout(revisionTimerRef.current);
      revisionTimerRef.current = null;
    }
  }, []);

  const stopInitialLoadingTimer = useCallback(() => {
    if (loadingTimerRef.current) {
      clearInterval(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    loadingStartedAtRef.current = 0;
    loadingReasonRef.current = null;
    setInitialLoadingReason(null);
    setLoadingElapsedSec(null);
  }, []);

  const startInitialLoadingTimer = useCallback((reason) => {
    if (loadingTimerRef.current && loadingReasonRef.current === reason) {
      return;
    }

    if (loadingTimerRef.current) {
      clearInterval(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }

    loadingStartedAtRef.current = Date.now();
    loadingReasonRef.current = reason;
    setInitialLoadingReason(reason);
    setLoadingElapsedSec(0);
    loadingTimerRef.current = setInterval(() => {
      const elapsedMs = Date.now() - loadingStartedAtRef.current;
      setLoadingElapsedSec(Math.max(0, Math.floor(elapsedMs / 1000)));
    }, 1000);
  }, []);

  useEffect(() => () => {
    if (loadingTimerRef.current) {
      clearInterval(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    if (codexUpdateHideTimerRef.current) {
      clearTimeout(codexUpdateHideTimerRef.current);
      codexUpdateHideTimerRef.current = null;
    }
    loadingReasonRef.current = null;
  }, []);

  const setAnimatedRealtimeTarget = useCallback((nextText, options = {}) => {
    const { immediate = false } = options;
    const normalized = String(nextText || "");
    const now = Date.now();
    const previousTarget = lastAnimatedTargetTextRef.current;
    const previousLength = Array.from(previousTarget).length;
    const nextLength = Array.from(normalized).length;
    const intervalMs = Math.max(1, now - lastAnimatedTargetAtRef.current);
    const addedChars = Math.max(1, Math.abs(nextLength - previousLength));
    const adaptiveStepMs = normalized.startsWith(previousTarget)
      ? Math.max(TYPEWRITER_MIN_STEP_MS, Math.min(TYPEWRITER_MAX_STEP_MS, Math.round(intervalMs / addedChars)))
      : TYPEWRITER_TYPE_STEP_MS;

    lastAnimatedTargetAtRef.current = now;
    lastAnimatedTargetTextRef.current = normalized;
    typewriterStepMsRef.current = adaptiveStepMs;
    displayTargetTextRef.current = normalized;
    setRealtimeText(normalized);

    if (immediate) {
      stopTypewriterAnimation();
      displayedRealtimeTextRef.current = normalized;
      setDisplayedRealtimeText(normalized);
      setRevisionParts([]);
      return;
    }

    stopTypewriterAnimation();
    const currentDisplayed = displayedRealtimeTextRef.current;
    if (normalized && !normalized.startsWith(currentDisplayed) && currentDisplayed !== normalized) {
      const revisionId = revisionSeqRef.current + 1;
      const nextRevisionParts = buildRevisionParts(currentDisplayed, normalized, revisionId);
      if (nextRevisionParts) {
        revisionSeqRef.current = revisionId;
        displayedRealtimeTextRef.current = normalized;
        setDisplayedRealtimeText(normalized);
        let animatedParts = nextRevisionParts;
        let partIndex = 0;

        const updatePart = (index, displayText) => {
          animatedParts = animatedParts.map((part, itemIndex) =>
            itemIndex === index ? { ...part, displayText } : part
          );
          setRevisionParts(animatedParts);
        };

        const finishRevision = () => {
          if (revisionSeqRef.current !== revisionId) return;
          revisionTimerRef.current = null;
          setRevisionParts([]);
        };

        const stepRevision = () => {
          if (revisionSeqRef.current !== revisionId) return;
          while (partIndex < animatedParts.length && animatedParts[partIndex].type === "stable") {
            partIndex += 1;
          }
          if (partIndex >= animatedParts.length) {
            finishRevision();
            return;
          }

          const part = animatedParts[partIndex];
          const currentText = part.displayText ?? part.text;
          const fullText = part.text;
          const currentLength = Array.from(currentText).length;

          if (part.type === "removed") {
            if (currentLength > 0) {
              updatePart(partIndex, sliceByCharacters(currentText, currentLength - 1));
              revisionTimerRef.current = setTimeout(stepRevision, Math.max(
                TYPEWRITER_MIN_STEP_MS,
                Math.round(TYPEWRITER_DELETE_STEP_MS * TYPEWRITER_FAST_DELETE_MULTIPLIER)
              ) * REVISION_STEP_SPEED_RATIO);
              return;
            }
            partIndex += 1;
            revisionTimerRef.current = setTimeout(stepRevision, 0);
            return;
          }

          if (part.type === "added") {
            const fullLength = Array.from(fullText).length;
            if (currentLength < fullLength) {
              updatePart(partIndex, sliceByCharacters(fullText, currentLength + 1));
              revisionTimerRef.current = setTimeout(stepRevision, typewriterStepMsRef.current * REVISION_STEP_SPEED_RATIO);
              return;
            }
            partIndex += 1;
            revisionTimerRef.current = setTimeout(stepRevision, 0);
            return;
          }

          partIndex += 1;
          revisionTimerRef.current = setTimeout(stepRevision, 0);
        };

        revisionTimerRef.current = setTimeout(stepRevision, 0);
        return;
      }
    }

    const tick = () => {
      const current = displayedRealtimeTextRef.current;
      const target = displayTargetTextRef.current;
      if (current === target) {
        typewriterTimerRef.current = null;
        return;
      }

      let prefixLength = 0;
      while (
        prefixLength < current.length &&
        prefixLength < target.length &&
        current[prefixLength] === target[prefixLength]
      ) {
        prefixLength += 1;
      }

      if (current.length > prefixLength) {
        const rollbackChars = current.length - prefixLength;
        const nextDisplayed = current.slice(0, current.length - 1);
        displayedRealtimeTextRef.current = nextDisplayed;
        setDisplayedRealtimeText(nextDisplayed);
        const baseDeleteStepMs = Math.max(
          TYPEWRITER_DELETE_STEP_MS,
          Math.round(typewriterStepMsRef.current * TYPEWRITER_DELETE_SPEED_RATIO)
        );
        const deleteStepMs = rollbackChars >= TYPEWRITER_FAST_DELETE_THRESHOLD
          ? Math.max(TYPEWRITER_MIN_STEP_MS, Math.round(baseDeleteStepMs * TYPEWRITER_FAST_DELETE_MULTIPLIER))
          : baseDeleteStepMs;
        typewriterTimerRef.current = setTimeout(tick, deleteStepMs);
        return;
      }

      const nextDisplayed = target.slice(0, current.length + 1);
      displayedRealtimeTextRef.current = nextDisplayed;
      setDisplayedRealtimeText(nextDisplayed);
      typewriterTimerRef.current = setTimeout(tick, typewriterStepMsRef.current);
    };

    typewriterTimerRef.current = setTimeout(tick, 0);
  }, [stopTypewriterAnimation]);

  const resetUI = useCallback(() => {
    if (codexUpdateHideTimerRef.current) {
      clearTimeout(codexUpdateHideTimerRef.current);
      codexUpdateHideTimerRef.current = null;
    }
    setAnimatedRealtimeTarget("", { immediate: true });
    statusRef.current = "idle";
    setStatus("idle");
    lastStatusAtRef.current = Date.now();
    setMessage("");
    setColdStartLoading(false);
    stopInitialLoadingTimer();
    resizeFloatingBall(400, 72);
  }, [resizeFloatingBall, setAnimatedRealtimeTarget, stopInitialLoadingTimer]);

  const stopCurrentTtsPlayback = useCallback(() => {
    if (ttsPlaybackCancelRef.current) {
      try {
        ttsPlaybackCancelRef.current();
      } catch (_) { }
      ttsPlaybackCancelRef.current = null;
    }
    if (ttsAudioRef.current) {
      try {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.currentTime = 0;
      } catch (_) { }
      ttsAudioRef.current = null;
    }
    if (ttsObjectUrlRef.current) {
      URL.revokeObjectURL(ttsObjectUrlRef.current);
      ttsObjectUrlRef.current = null;
    }
  }, []);

  const logRuntime = useCallback((level, message, data = null) => {
    if (window.electronAPI?.log) {
      window.electronAPI.log(level, message, data).catch(() => { });
      return;
    }
    const logger = console[level] || console.log;
    logger(message, data || "");
  }, []);

  const finishOutputControl = useCallback(() => {
    outputControlRef.current.interrupted = true;
    if (window.electronAPI?.setDictationKeyCaptureEnabled) {
      window.electronAPI.setDictationKeyCaptureEnabled(false).catch(() => { });
    }
    if (window.electronAPI?.setFloatingBallInputCaptureEnabled) {
      window.electronAPI.setFloatingBallInputCaptureEnabled(false).catch(() => { });
    }
  }, []);

  const cancelCurrentOutput = useCallback((reason = "escape") => {
    pendingDictationConfirmRef.current = false;
    finishOutputControl();
    outputControlRef.current.reason = "cancel";
    stopTypewriterAnimation();
    cancelRecording();
    setAnimatedRealtimeTarget("", { immediate: true });
    setMessage("");
    setColdStartLoading(false);
    setStatus("idle");
    statusRef.current = "idle";
    resetUI();
    hideFloatingBall();
    logRuntime("info", "Dictation output cancelled", { reason });
  }, [
    cancelRecording,
    finishOutputControl,
    hideFloatingBall,
    logRuntime,
    resetUI,
    setAnimatedRealtimeTarget,
    stopTypewriterAnimation,
  ]);

  const confirmCurrentOutput = useCallback(async () => {
    const currentStatus = statusRef.current;
    if (
      isRecordingRef.current ||
      isRecordingProcessing ||
      currentStatus === "recording" ||
      currentStatus === "processing"
    ) {
      pendingDictationConfirmRef.current = true;
      logRuntime("info", "Dictation confirm queued until recording finalizes", {
        status: currentStatus,
        isRecording: isRecordingRef.current,
        isProcessing: isRecordingProcessing,
      });
      return;
    }

    const outputGeneration = outputControlRef.current.generation;
    if (!isCurrentOutputGeneration(outputGeneration, {
      allowInterruptedConfirm: true,
    })) {
      return;
    }

    const currentText = (
      displayedRealtimeTextRef.current ||
      displayTargetTextRef.current ||
      realtimeText ||
      ""
    ).trim();

    if (!currentText) {
      finishOutputControl();
      outputControlRef.current.reason = "confirm_empty";
      stopTypewriterAnimation();
      cancelRecording();
      setAnimatedRealtimeTarget("", { immediate: true });
      setMessage("");
      setColdStartLoading(false);
      setStatus("idle");
      statusRef.current = "idle";
      resetUI();
      hideFloatingBall();
      logRuntime("info", "Dictation confirm closed because no output text is available");
      return;
    }

    finishOutputControl();
    outputControlRef.current.reason = "confirm";
    stopTypewriterAnimation();
    cancelRecording();
    setColdStartLoading(false);
    setAnimatedRealtimeTarget(currentText, { immediate: true });
    await transitionStatus("pasting");
    if (outputControlRef.current.reason !== "confirm") {
      return;
    }
    const pasteResult = await safePaste(currentText, outputGeneration);

    if (outputControlRef.current.reason !== "confirm") {
      return;
    }

    if (!isCurrentOutputGeneration(outputGeneration, {
      allowInterruptedConfirm: true,
    })) {
      return;
    }

    await transitionStatus(pasteResult.ok ? "completed" : "error");
    setMessage(pasteResult.ok ? "" : "粘贴失败（文本已复制）");
    setTimeout(() => {
      resetUI();
      hideFloatingBall();
    }, pasteResult.ok ? 350 : 1800);
    logRuntime("info", "Dictation output confirmed by Enter", {
      textLength: currentText.length,
      pasteOk: pasteResult.ok,
      pasteMode: pasteResult.mode,
    });
  }, [
    finishOutputControl,
    hideFloatingBall,
    logRuntime,
    realtimeText,
    resetUI,
    safePaste,
    setAnimatedRealtimeTarget,
    stopTypewriterAnimation,
    transitionStatus,
    cancelRecording,
    isRecordingProcessing,
  ]);

  const makeTraceId = useCallback(() => {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `tts-${ts}-${rand}`;
  }, []);

  const isAbortLikeError = useCallback((err) => {
    const messageText = String(err?.message || '').toLowerCase();
    return err?.name === 'AbortError' || messageText.includes('aborted');
  }, []);

  const abortActiveTtsRequests = useCallback(() => {
    for (const controller of ttsAbortControllersRef.current) {
      try {
        controller.abort();
      } catch (_) { }
    }
    ttsAbortControllersRef.current.clear();
  }, []);

  const splitTextForTtsFallback = useCallback((rawText, maxChars = 60) => {
    const normalized = String(rawText || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!normalized) return [];

    const hardLimit = Math.max(20, Number(maxChars) || 60);
    const splitWithDelims = (input, delims) => {
      const pieces = [];
      let buf = '';
      for (const ch of input) {
        buf += ch;
        if (delims.has(ch)) {
          const value = buf.trim();
          if (value) pieces.push(value);
          buf = '';
        }
      }
      const tail = buf.trim();
      if (tail) pieces.push(tail);
      return pieces;
    };

    const strong = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n']);
    const weak = new Set(['，', ',', '、', '：', ':']);
    const level1 = splitWithDelims(normalized, strong);
    const level2 = [];
    for (const seg of (level1.length ? level1 : [normalized])) {
      if (seg.length <= hardLimit) {
        level2.push(seg);
        continue;
      }
      const weakSplit = splitWithDelims(seg, weak);
      for (const piece of (weakSplit.length ? weakSplit : [seg])) {
        if (piece.length <= hardLimit) {
          level2.push(piece);
          continue;
        }
        for (let i = 0; i < piece.length; i += hardLimit) {
          const part = piece.slice(i, i + hardLimit).trim();
          if (part) level2.push(part);
        }
      }
    }
    return level2.filter(Boolean);
  }, []);

  const syncClipboardWatchState = useCallback(() => {
    const shouldWatch = ttsEnabledRef.current || translateModeRef.current === 'translate';
    if (window.electronAPI?.setClipboardWatchEnabled) {
      window.electronAPI.setClipboardWatchEnabled(shouldWatch).catch(() => { });
    }
    return shouldWatch;
  }, []);

  const syncTtsEnabledState = useCallback((enabled) => {
    const next = !!enabled;
    ttsEnabledRef.current = next;
    setTtsEnabled(next);
    logRuntime("info", "TTS enabled state changed", { enabled: next });

    if (next || translateModeRef.current === 'translate') {
      if (window.electronAPI?.readClipboard) {
        window.electronAPI.readClipboard()
          .then((result) => {
            if (result?.success) {
              lastClipboardTextRef.current = String(result.text || "").trim();
            }
          })
          .catch(() => { })
          .finally(() => {
            syncClipboardWatchState();
          });
      } else {
        syncClipboardWatchState();
      }
    } else {
      lastClipboardTextRef.current = "";
      syncClipboardWatchState();
      stopCurrentTtsPlayback();
      abortActiveTtsRequests();
    }
  }, [abortActiveTtsRequests, logRuntime, stopCurrentTtsPlayback, syncClipboardWatchState]);

  // Synchronize translateMode with ref
  useEffect(() => {
    translateModeRef.current = translateMode;
    syncClipboardWatchState();
  }, [translateMode, syncClipboardWatchState]);

  const playClipboardText = useCallback(async (text, source = 'clipboard', options = {}) => {
    const content = (text || '').trim();
    if (!content) return;
    const { skipTranslate = false } = options;
    const shouldProcess = ttsEnabledRef.current || translateMode === 'translate';
    if (!shouldProcess) return;
    const pipelineStartedAt = performance.now();
    const traceId = makeTraceId();
    logRuntime("info", "TTS trigger accepted", {
      traceId,
      source,
      textLength: content.length,
      translateMode,
      translateTarget
    });

    if (source === 'clipboard') {
      lastClipboardTextRef.current = content;
    }

    const requestId = ++ttsRequestIdRef.current;
    stopCurrentTtsPlayback();
    abortActiveTtsRequests();

    const registerAbortController = () => {
      const controller = new AbortController();
      ttsAbortControllersRef.current.add(controller);
      return {
        controller,
        cleanup: () => {
          ttsAbortControllersRef.current.delete(controller);
        }
      };
    };

    const isStaleTtsRequest = () => requestId !== ttsRequestIdRef.current;
    const throwIfStaleTtsRequest = () => {
      if (isStaleTtsRequest()) {
        throw new Error('TTS request aborted');
      }
    };

    const playAudioBlob = async ({ audioBlob, chunkIndex, chunkTotal, chunkText }) => {
      throwIfStaleTtsRequest();
      const audioDurationSec = await estimateAudioBlobDurationSeconds(audioBlob);
      throwIfStaleTtsRequest();
      const currentChunkText = String(chunkText || "");
      const maxAllowedSec = estimateTtsAllowedSeconds(currentChunkText);
      if (audioDurationSec && audioDurationSec > maxAllowedSec) {
        logRuntime("error", "TTS abnormal audio skipped", {
          traceId,
          source,
          chunkIndex: chunkIndex + 1,
          chunkTotal,
          textLength: currentChunkText.length,
          audioBytes: audioBlob?.size || 0,
          durationSec: Number(audioDurationSec.toFixed(2)),
          maxAllowedSec: Number(maxAllowedSec.toFixed(2))
        });
        throw new Error(`TTS 音频异常过长（${Math.round(audioDurationSec)}s），已跳过播放`);
      }

      throwIfStaleTtsRequest();
      const objectUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(objectUrl);
      ttsObjectUrlRef.current = objectUrl;
      ttsAudioRef.current = audio;

      let cancelPlaybackWaitForAudio = null;
      try {
        setMessage(chunkTotal > 1 ? `语音播报中（${chunkIndex + 1}/${chunkTotal}）...` : '语音播报中...');
        const playStartedAt = performance.now();
        await audio.play();
        throwIfStaleTtsRequest();
        logRuntime("info", "TTS audio playback started", {
          traceId,
          source,
          chunkIndex: chunkIndex + 1,
          chunkTotal,
          startupMs: Math.round(performance.now() - playStartedAt),
          totalMs: Math.round(performance.now() - pipelineStartedAt)
        });

        await new Promise((resolve, reject) => {
          let settled = false;
          let cancelPlaybackWait = null;
          const cleanupPlaybackWait = () => {
            if (ttsPlaybackCancelRef.current === cancelPlaybackWait) {
              ttsPlaybackCancelRef.current = null;
            }
            audio.onended = null;
            audio.onerror = null;
          };
          const settle = (callback) => {
            if (settled) return;
            settled = true;
            cleanupPlaybackWait();
            callback();
          };
          cancelPlaybackWait = () => {
            settle(() => reject(new Error('TTS playback aborted')));
          };
          cancelPlaybackWaitForAudio = cancelPlaybackWait;
          ttsPlaybackCancelRef.current = cancelPlaybackWait;
          audio.onended = () => settle(resolve);
          audio.onerror = () => settle(() => reject(new Error('Audio playback failed')));
        });
        throwIfStaleTtsRequest();
        logRuntime("info", "TTS audio playback ended", {
          traceId,
          source,
          chunkIndex: chunkIndex + 1,
          chunkTotal,
          totalMs: Math.round(performance.now() - pipelineStartedAt)
        });
      } finally {
        if (ttsPlaybackCancelRef.current === cancelPlaybackWaitForAudio) {
          ttsPlaybackCancelRef.current = null;
        }
        if (ttsAudioRef.current === audio) {
          ttsAudioRef.current = null;
        }
        if (ttsObjectUrlRef.current === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          ttsObjectUrlRef.current = null;
        }
      }
    };

    const fetchChunkAudioWithRetry = async (chunkText, chunkIndex) => {
      const ttsVoice = resolveTtsRequestVoice(chunkText, ttsSpeakerRef.current);
      const maxNewTokens = estimateTtsMaxNewTokens(chunkText);
      let attempt = 0;
      while (attempt <= TTS_CHUNK_RETRY) {
        const ttsStartedAt = performance.now();
        const { controller, cleanup } = registerAbortController();
        try {
          logRuntime("info", "TTS backend request started", {
            traceId,
            source,
            chunkIndex: chunkIndex + 1,
            textLength: chunkText.length,
            language: ttsVoice.language,
            speaker: ttsVoice.speaker,
            maxNewTokens,
            attempt: attempt + 1
          });
          const audioBlob = await speakText(chunkText, {
            language: ttsVoice.language,
            speed: ttsSpeedRef.current,
            speaker: ttsVoice.speaker,
            instruction: ttsInstructionRef.current,
            maxNewTokens,
            traceId: `${traceId}-c${chunkIndex + 1}-a${attempt + 1}`,
            signal: controller.signal
          });
          logRuntime("info", "TTS backend response received", {
            traceId,
            source,
            chunkIndex: chunkIndex + 1,
            textLength: chunkText.length,
            audioBytes: audioBlob?.size || 0,
            workerId: audioBlob?.ttsDiagnostics?.workerId || undefined,
            maxNewTokens: audioBlob?.ttsDiagnostics?.maxNewTokens || maxNewTokens,
            normalizer: audioBlob?.ttsDiagnostics?.normalizer || undefined,
            hitTokenCap: audioBlob?.ttsDiagnostics?.hitTokenCap || undefined,
            suspiciousDuration: audioBlob?.ttsDiagnostics?.suspiciousDuration || undefined,
            audioSeconds: audioBlob?.ttsDiagnostics?.audioSeconds || undefined,
            elapsedSeconds: audioBlob?.ttsDiagnostics?.elapsedSeconds || undefined,
            rtf: audioBlob?.ttsDiagnostics?.rtf || undefined,
            ms: Math.round(performance.now() - ttsStartedAt)
          });
          throwIfStaleTtsRequest();
          return audioBlob;
        } catch (ttsErr) {
          if (isAbortLikeError(ttsErr) || requestId !== ttsRequestIdRef.current) {
            throw ttsErr;
          }
          const canRetry = attempt < TTS_CHUNK_RETRY;
          logRuntime(canRetry ? "warn" : "error", canRetry ? "TTS chunk request failed, retrying" : "TTS chunk request failed", {
            traceId,
            source,
            chunkIndex: chunkIndex + 1,
            attempt: attempt + 1,
            error: ttsErr?.message || String(ttsErr),
            ms: Math.round(performance.now() - ttsStartedAt)
          });
          if (!canRetry) {
            throw ttsErr;
          }
          attempt += 1;
        } finally {
          cleanup();
        }
      }
      throw new Error('Unexpected chunk retry state');
    };

    try {
      let contentForSpeak = content;
      const shouldTranslateBeforeSpeak = translateMode === 'translate' && !skipTranslate;
      if (shouldTranslateBeforeSpeak) {
        const translateStartedAt = performance.now();
        logRuntime("info", "TTS translate started", {
          traceId,
          source,
          inputLength: content.length,
          target: translateTarget || 'zh'
        });
        setMessage('翻译中...');
        try {
          const { controller, cleanup } = registerAbortController();
          let translated;
          try {
            translated = await translateText(content, translateTarget || 'zh', {
              traceId,
              signal: controller.signal
            });
          } finally {
            cleanup();
          }
          if (requestId !== ttsRequestIdRef.current) return;
          contentForSpeak = (translated?.translated_text || '').trim() || content;
          logRuntime("info", "TTS translate finished", {
            traceId,
            source,
            fallback: !!translated?.fallback,
            fallbackError: translated?.error || "",
            inputLength: content.length,
            outputLength: contentForSpeak.length,
            ms: Math.round(performance.now() - translateStartedAt)
          });
          if (translated?.fallback) {
            const fallbackError = (translated?.error || '').trim();
            setMessage(fallbackError ? `翻译失败，已回退原文：${fallbackError}` : '翻译失败，已回退原文播报');
            logRuntime("warn", "TTS translate returned fallback source text", {
              traceId,
              source,
              error: fallbackError || undefined
            });
          } else if (contentForSpeak !== content && window.electronAPI?.saveTranslatedClipboard) {
            window.electronAPI.saveTranslatedClipboard(content, contentForSpeak).catch(err => {
              logRuntime("warn", "Failed to save translated clipboard history", {
                error: err?.message || String(err)
              });
            });
            if (source === 'clipboard' && window.electronAPI?.writeClipboard) {
              lastClipboardTextRef.current = contentForSpeak;
              window.electronAPI.writeClipboard(contentForSpeak).then(() => {
                logRuntime("info", "Translated clipboard text written back to clipboard", {
                  traceId,
                  target: translateTarget || 'zh',
                  textLength: contentForSpeak.length
                });
              }).catch((err) => {
                logRuntime("warn", "Failed to write translated text back to clipboard", {
                  traceId,
                  error: err?.message || String(err)
                });
              });
            }
          }
        } catch (translateErr) {
          logRuntime("warn", "TTS translate failed, fallback to source", {
            traceId,
            source,
            error: translateErr?.message || String(translateErr),
            ms: Math.round(performance.now() - translateStartedAt)
          });
          setMessage(`翻译失败，已回退原文：${translateErr.message}`);
          contentForSpeak = content;
        }
      }

      // Если text-to-speech is completely disabled, then we just exit immediately
      // after saving the translation to the clipboard history.
      if (!ttsEnabledRef.current) {
        logRuntime("info", "TTS is disabled, skipping audio playback pipeline");
        return;
      }

      const planStartedAt = performance.now();
      const planVoice = resolveTtsRequestVoice(contentForSpeak, ttsSpeakerRef.current);
      const fallbackChunks = splitTextForTtsFallback(contentForSpeak, ttsPlanMaxChars);
      let chunks = fallbackChunks.length ? fallbackChunks : [contentForSpeak];
      try {
        const { controller, cleanup } = registerAbortController();
        let planResult;
        try {
          planResult = await planTtsChunks(contentForSpeak, {
            traceId,
            maxCharsPerChunk: ttsPlanMaxChars,
            langHint: planVoice.language,
            signal: controller.signal
          });
        } finally {
          cleanup();
        }
        if (requestId !== ttsRequestIdRef.current) return;
        const planned = Array.isArray(planResult?.chunks)
          ? planResult.chunks.map((item) => String(item?.text || '').trim()).filter(Boolean)
          : [];
        if (planned.length > 0) {
          chunks = planned;
        } else if (Number(planResult?.total_chunks || 0) === 0 || !String(planResult?.text || '').trim()) {
          chunks = [];
        }
        logRuntime("info", "TTS chunk plan ready", {
          traceId,
          source,
          provider: "backend",
          remote: isRemoteTts,
          inputLength: contentForSpeak.length,
          normalizedLength: String(planResult?.text || '').length || undefined,
          sanitized: Boolean(planResult?.sanitized),
          normalizer: planResult?.normalizer || undefined,
          chunks: chunks.length,
          longestChunk: chunks.length ? Math.max(...chunks.map((item) => item.length)) : 0,
          planMaxChars: ttsPlanMaxChars,
          ms: Math.round(performance.now() - planStartedAt)
        });
      } catch (planErr) {
        if (isAbortLikeError(planErr) || requestId !== ttsRequestIdRef.current) return;
        logRuntime("warn", "TTS chunk plan failed, fallback to local chunks", {
          traceId,
          source,
          provider: "local",
          remote: isRemoteTts,
          error: planErr?.message || String(planErr),
          fallbackChunks: chunks.length,
          planMaxChars: ttsPlanMaxChars,
          ms: Math.round(performance.now() - planStartedAt)
        });
      }

      if (!chunks.length) {
        throw new Error('No TTS chunk generated');
      }

      logRuntime("info", "TTS queue synthesis configured", {
        traceId,
        source,
        chunks: chunks.length,
        remote: isRemoteTts,
        workersReady: ttsWorkersReady || undefined,
        recommendedPrefetch: ttsRecommendedPrefetch || undefined,
        prefetch: ttsPrefetchWindow
      });

      const inFlightChunkMap = new Map();
      const ensureChunkInFlight = (index) => {
        if (requestId !== ttsRequestIdRef.current) return;
        if (index < 0 || index >= chunks.length) return;
        if (inFlightChunkMap.has(index)) return;
        logRuntime("info", "TTS chunk dispatched", {
          traceId,
          source,
          chunkIndex: index + 1,
          chunkTotal: chunks.length,
          inFlight: inFlightChunkMap.size + 1,
          prefetch: ttsPrefetchWindow
        });
        const promise = fetchChunkAudioWithRetry(chunks[index], index);
        promise.catch(() => { });
        inFlightChunkMap.set(index, promise);
      };
      for (let i = 0; i < Math.min(chunks.length, ttsPrefetchWindow); i += 1) {
        ensureChunkInFlight(i);
      }

      let consecutiveFailures = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        if (requestId !== ttsRequestIdRef.current) return;
        for (let lookahead = index; lookahead < index + ttsPrefetchWindow; lookahead += 1) {
          ensureChunkInFlight(lookahead);
        }

        const currentPromise = inFlightChunkMap.get(index);
        if (!currentPromise) {
          throw new Error(`TTS chunk promise missing at index ${index}`);
        }

        let audioBlob;
        try {
          audioBlob = await currentPromise;
        } catch (chunkErr) {
          if (isAbortLikeError(chunkErr) || requestId !== ttsRequestIdRef.current) return;
          consecutiveFailures += 1;
          logRuntime("warn", "TTS chunk skipped after retries", {
            traceId,
            source,
            chunkIndex: index + 1,
            chunkTotal: chunks.length,
            error: chunkErr?.message || String(chunkErr),
            consecutiveFailures
          });
          if (consecutiveFailures >= TTS_FAIL_STOP_THRESHOLD) {
            throw new Error(`连续 ${consecutiveFailures} 句播报失败，已停止`);
          }
          inFlightChunkMap.delete(index);
          ensureChunkInFlight(index + ttsPrefetchWindow);
          continue;
        }

        consecutiveFailures = 0;
        inFlightChunkMap.delete(index);
        ensureChunkInFlight(index + ttsPrefetchWindow);
        if (requestId !== ttsRequestIdRef.current) return;
        await playAudioBlob({
          audioBlob,
          chunkIndex: index,
          chunkTotal: chunks.length,
          chunkText: chunks[index]
        });
        if (requestId !== ttsRequestIdRef.current) return;
      }

      logRuntime("info", "TTS queue playback finished", {
        traceId,
        source,
        chunks: chunks.length,
        totalMs: Math.round(performance.now() - pipelineStartedAt)
      });
    } catch (err) {
      if (isAbortLikeError(err) || requestId !== ttsRequestIdRef.current) return;
      logRuntime("error", "TTS pipeline failed", {
        traceId,
        source,
        error: err?.message || String(err),
        totalMs: Math.round(performance.now() - pipelineStartedAt)
      });
      if (requestId === ttsRequestIdRef.current) {
        setMessage(`播报失败：${err.message}`);
      }
    } finally {
      if (requestId === ttsRequestIdRef.current) {
        abortActiveTtsRequests();
      }
    }
  }, [
    abortActiveTtsRequests,
    isAbortLikeError,
    isRemoteTts,
    logRuntime,
    makeTraceId,
    splitTextForTtsFallback,
    stopCurrentTtsPlayback,
    ttsPlanMaxChars,
    ttsPrefetchWindow,
    ttsRecommendedPrefetch,
    ttsWorkersReady,
    translateMode,
    translateTarget
  ]);

  const clearVoiceLearningPrompt = useCallback(() => {
    voiceLearningCandidateRef.current = null;
    if (voiceLearningHideTimerRef.current) {
      clearTimeout(voiceLearningHideTimerRef.current);
      voiceLearningHideTimerRef.current = null;
    }
    window.electronAPI?.setFloatingBallInputCaptureEnabled?.(false).catch(() => { });
  }, []);

  const extractHotwordTerms = useCallback((value) => {
    if (isExactSilentASRArtifactText(value)) {
      return [];
    }
    const seen = new Set();
    return String(value || "")
      .split(/[\n,;，；、|]+/)
      .map((item) => item.trim())
      .filter((item) => item && item.length <= 80 && !item.startsWith("#"))
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 80);
  }, []);

  const extractClipboardText = useCallback((payload) => {
    if (typeof payload === "string") {
      return payload;
    }
    if (payload && typeof payload === "object") {
      if (payload.success === false) {
        throw new Error(payload.error || "无法读取剪贴板");
      }
      return String(payload.text || "");
    }
    return "";
  }, []);

  const captureClipboardHotwords = useCallback(async () => {
    try {
      const clipboardPayload = await window.electronAPI?.readClipboard?.();
      const clipboardText = extractClipboardText(clipboardPayload);
      const terms = extractHotwordTerms(clipboardText);
      if (!terms.length) {
        return { success: true, count: 0, terms: [] };
      }
      const learnResult = await learnHotwords(terms, { source: "clipboard" });
      if (!learnResult?.success) {
        throw new Error(learnResult?.error || "服务端热词保存失败");
      }
      const merged = [];
      const seen = new Set();
      [...sessionHotwordsRef.current, ...terms].forEach((term) => {
        const key = String(term || "").trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(String(term).trim());
      });
      sessionHotwordsRef.current = merged.slice(-120);
      logRuntime("info", "Captured clipboard hotwords for session", {
        added: learnResult.added_count ?? learnResult.added?.length ?? terms.length,
        ruleAdded: learnResult.rule_added_count ?? learnResult.rule_added?.length ?? 0,
        existing: learnResult.existing_count ?? learnResult.existing?.length ?? 0,
        total: sessionHotwordsRef.current.length
      });
      return {
        success: true,
        count: learnResult.added_count ?? learnResult.added?.length ?? terms.length,
        ruleCount: learnResult.rule_added_count ?? learnResult.rule_added?.length ?? 0,
        existing: learnResult.existing_count ?? learnResult.existing?.length ?? 0,
        ruleExisting: learnResult.rule_existing_count ?? learnResult.rule_existing?.length ?? 0,
        ruleSource: learnResult.rule_source || "none",
        total: sessionHotwordsRef.current.length,
        terms,
        persisted: true
      };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }, [extractClipboardText, extractHotwordTerms, logRuntime]);

  const clearCodexUpdateHideTimer = useCallback(() => {
    if (codexUpdateHideTimerRef.current) {
      clearTimeout(codexUpdateHideTimerRef.current);
      codexUpdateHideTimerRef.current = null;
    }
  }, []);

  const dismissCodexVoiceSurface = useCallback((reason = "escape") => {
    clearCodexUpdateHideTimer();
    clearVoiceLearningPrompt();
    outputControlRef.current.interrupted = true;
    outputControlRef.current.reason = "cancel";
    codexSubmitInFlightRef.current = false;
    recordingModeRef.current = "dictation";
    cancelRecording();
    window.electronAPI?.cancelCodexVoiceRoute?.({ reason, interruptCodex: false }).catch(() => { });
    window.electronAPI?.setFloatingBallInputCaptureEnabled?.(false).catch(() => { });
    resetUI();
    hideFloatingBall();
    logRuntime("info", "Codex voice surface dismissed", { reason });
    return true;
  }, [cancelRecording, clearCodexUpdateHideTimer, clearVoiceLearningPrompt, hideFloatingBall, logRuntime, resetUI]);

  const scheduleVoiceLearningPrompt = useCallback((candidate, messagePrefix = "已执行语音指令") => {
    if (!candidate) return false;
    clearVoiceLearningPrompt();
    voiceLearningCandidateRef.current = candidate;
    setMessage(`${messagePrefix}。Enter 学习 / 双击 Caps 跳过（Esc 备用）`);
    window.electronAPI?.setFloatingBallInputCaptureEnabled?.(true).catch(() => { });
    return true;
  }, [clearVoiceLearningPrompt]);

  const confirmVoiceLearningPrompt = useCallback(async () => {
    const candidate = voiceLearningCandidateRef.current;
    if (!candidate) return false;
    clearVoiceLearningPrompt();
    try {
      const result = await window.electronAPI?.learnVoiceRouteShortcut?.(candidate);
      if (!result || result.success === false) {
        throw new Error(result?.error || "学习失败");
      }
      await transitionStatus("completed");
      setMessage(result.updated ? "已更新快捷话术" : "已学习快捷话术");
      window.electronAPI?.setFloatingBallInputCaptureEnabled?.(true).catch(() => { });
    } catch (error) {
      await transitionStatus("error");
      setMessage(`学习失败：${error?.message || String(error)}`);
      window.electronAPI?.setFloatingBallInputCaptureEnabled?.(true).catch(() => { });
    }
    return true;
  }, [clearVoiceLearningPrompt, transitionStatus]);

  const skipVoiceLearningPrompt = useCallback(() => {
    if (!voiceLearningCandidateRef.current) return false;
    clearVoiceLearningPrompt();
    resetUI();
    hideFloatingBall();
    return true;
  }, [clearVoiceLearningPrompt, hideFloatingBall, resetUI]);

  const handleCodexRecordingComplete = useCallback(async (transcriptionResult) => {
    const recognizedText = String(
      transcriptionResult?.text ||
      transcriptionResult?.asr_text ||
      transcriptionResult?.raw_asr_text ||
      transcriptionResult?.voice_command_phrase ||
      ""
    ).trim();
    if (!transcriptionResult?.success || !recognizedText) {
      await transitionStatus("error");
      setMessage("未识别到内容。双击 Caps 关闭（Esc 备用）");
      return;
    }

    if (codexSubmitInFlightRef.current) {
      logRuntime("warn", "Ignore duplicate MiniCPM voice submit while previous submit is in flight");
      return;
    }

    codexSubmitInFlightRef.current = true;
    clearCodexUpdateHideTimer();
    setAnimatedRealtimeTarget("", { immediate: true });
    await transitionStatus("pasting");
    setMessage("正在发送给窝窝头");
    window.electronAPI?.setDictationKeyCaptureEnabled?.(true).catch(() => { });
    window.electronAPI?.setFloatingBallInputCaptureEnabled?.(true).catch(() => { });

    try {
      const result = await window.electronAPI?.submitMiniCPMVoicePrompt?.(recognizedText);
      if (outputControlRef.current.interrupted && outputControlRef.current.reason === "cancel") {
        return;
      }
      if (!result || result.success === false) {
        throw new Error(result?.error || "MiniCPM voice bridge unavailable");
      }
      await transitionStatus("completed");
      setMessage(result?.message || "已发送给窝窝头");
      logRuntime("info", "MiniCPM voice prompt submitted", {
        textLength: recognizedText.length,
        port: result?.port || null,
      });
      setTimeout(() => {
        resetUI();
        hideFloatingBall();
      }, 500);
    } catch (error) {
      if (outputControlRef.current.interrupted && outputControlRef.current.reason === "cancel") {
        return;
      }
      await transitionStatus("error");
      window.electronAPI?.setFloatingBallInputCaptureEnabled?.(true).catch(() => { });
      setMessage(`发送到窝窝头失败：${error?.message || String(error)}。双击 Caps 关闭（Esc 备用）`);
    } finally {
      codexSubmitInFlightRef.current = false;
    }
  }, [clearCodexUpdateHideTimer, hideFloatingBall, logRuntime, resetUI, setAnimatedRealtimeTarget, transitionStatus]);

  const handleRecordingComplete = useCallback(async (transcriptionResult) => {
    const queuedConfirm = pendingDictationConfirmRef.current;
    pendingDictationConfirmRef.current = false;
    if (recordingModeRef.current === "codex") {
      await handleCodexRecordingComplete(transcriptionResult);
      return;
    }

    const outputGeneration = outputControlRef.current.generation;
    if (!isCurrentOutputGeneration(outputGeneration)) {
      logRuntime("info", "Ignore transcription completion after output interruption", {
        reason: outputControlRef.current.reason,
      });
      return;
    }

    if (transcriptionResult.success && transcriptionResult.voice_command_applied && !String(transcriptionResult.text || '').trim()) {
      setAnimatedRealtimeTarget('', { immediate: true });
      await transitionStatus('completed');
      setMessage('已清空本次草稿');
      logRuntime("info", "Voice edit command cleared current dictation draft", {
        commandType: transcriptionResult.voice_command_type || '',
      });
      setTimeout(() => {
        resetUI();
        hideFloatingBall();
      }, 700);
      return;
    }

    if (transcriptionResult.success && transcriptionResult.text) {
      const completionStartedAt = performance.now();
      const recognizedText = (transcriptionResult.text || '').trim();
      const postprocessMode = (transcriptionResult.postprocess_mode || 'none').toLowerCase();
      const fastMode = fastInputModeRef.current;
      if (queuedConfirm) {
        logRuntime("info", "Queued dictation confirm consumed by recording completion", {
          textLength: recognizedText.length,
          fastInputMode: fastMode,
        });
      }
      if (!fastMode) {
        setAnimatedRealtimeTarget(recognizedText, { immediate: true });
      }

      const triggerVoiceTts = () => {
        if (!ttsEnabledRef.current || !recognizedText) return;
        lastClipboardTextRef.current = recognizedText;
        const skipTranslate = postprocessMode === 'cleanup' || postprocessMode === 'translate';
        logRuntime("info", "TTS trigger from voice recognition", {
          textLength: recognizedText.length,
          postprocessMode,
          skipTranslate,
          fastInputMode: fastMode,
        });
        playClipboardText(recognizedText, 'voice', { skipTranslate }).catch(() => { });
      };

      if (fastMode) {
        const pasteStartedAt = performance.now();
        const pasteResult = await safePaste(recognizedText, outputGeneration);
        if (!isCurrentOutputGeneration(outputGeneration)) {
          return;
        }
        const pasteMs = Math.round(performance.now() - pasteStartedAt);
        if (!isCurrentOutputGeneration(outputGeneration)) {
          return;
        }
        logRuntime("info", "Fast input paste completed", {
          fastInputMode: true,
          textLength: recognizedText.length,
          pasteMs,
          totalMs: Math.round(performance.now() - completionStartedAt),
          pasteMode: pasteResult.mode,
          pasteOk: pasteResult.ok,
        });
        if (!isCurrentOutputGeneration(outputGeneration)) {
          return;
        }
        triggerVoiceTts();
        if (!isCurrentOutputGeneration(outputGeneration)) {
          return;
        }

        if (pasteResult.ok) {
          if (!isCurrentOutputGeneration(outputGeneration)) {
            return;
          }
          setStatus("completed");
          setMessage(pasteResult.mode === "copied" ? "已复制" : "已粘贴");
          setTimeout(() => {
            resetUI();
            hideFloatingBall();
          }, 350);
          return;
        }

        await transitionStatus("error");
        setMessage("粘贴失败（文本已复制）");
        setTimeout(() => {
          resetUI();
          hideFloatingBall();
        }, 1800);
        return;
      }

      // 语音输入完成后直接触发播报；同时写入去重缓存，避免剪贴板轮询重复播报同一文本。
      if (!isCurrentOutputGeneration(outputGeneration)) {
        return;
      }
      triggerVoiceTts();

      const pasteTask = safePaste(recognizedText, outputGeneration);
      await transitionStatus("preview_ready");
      if (!isCurrentOutputGeneration(outputGeneration)) {
        return;
      }
      setMessage("识别完成");
      await transitionStatus("pasting");
      if (!isCurrentOutputGeneration(outputGeneration)) {
        return;
      }
      setMessage("正在粘贴...");
      const pasteResult = await pasteTask;
      if (!isCurrentOutputGeneration(outputGeneration)) {
        return;
      }

      await transitionStatus(pasteResult.ok ? "completed" : "error");
      if (pasteResult.ok) {
        const messageMap = {
          pasted: "已粘贴",
          copied: "已复制",
          skipped: "已粘贴",
        };
        setMessage(messageMap[pasteResult.mode] || "已粘贴");
      } else {
        setMessage("粘贴失败（文本已复制）");
      }

      setTimeout(() => {
        resetUI();
        hideFloatingBall();
      }, pasteResult.ok ? 1500 : 2200);
      return;
    }

    await transitionStatus("error");
    setMessage("未识别到内容");
    setTimeout(() => {
      resetUI();
      hideFloatingBall();
    }, 1200);
  }, [handleCodexRecordingComplete, logRuntime, safePaste, setAnimatedRealtimeTarget, transitionStatus, hideFloatingBall, resetUI, playClipboardText]);

  const handleTranscriptionProgress = useCallback((payload) => {
    const stage = (payload?.stage || '').toLowerCase();

    if (stage === 'cold_start_loading') {
      if (outputControlRef.current.interrupted) return;
      startInitialLoadingTimer('cold_start');
      setColdStartLoading(true);
      setMessage(payload?.message || '模型冷启动中');
      transitionStatus('recording');
      return;
    }

    if (stage === 'realtime_ready') {
      if (outputControlRef.current.interrupted) return;
      stopInitialLoadingTimer();
      setColdStartLoading(false);
      setMessage('');
      return;
    }

    if (stage === 'mode_warning') {
      if (outputControlRef.current.interrupted) return;
      stopInitialLoadingTimer();
      setColdStartLoading(false);
      setMessage(payload?.message || '翻译链路异常，已回退识别文本');
      return;
    }

    if (stage === 'uploading_or_starting') {
      if (outputControlRef.current.interrupted) return;
      stopInitialLoadingTimer();
      setColdStartLoading(false);
      transitionStatus('processing');
      setMessage('');
      return;
    }

    if (stage === 'recognizing') {
      if (outputControlRef.current.interrupted) return;
      stopInitialLoadingTimer();
      setColdStartLoading(false);
      const hasRealtimeTextUpdate = payload?.source === 'realtime'
        && (typeof payload?.text === 'string' || payload?.voiceCommandApplied === true);
      if (hasRealtimeTextUpdate) {
        setAnimatedRealtimeTarget(payload.text || '');
      } else if (!fastInputModeRef.current && payload?.text) {
        setAnimatedRealtimeTarget(payload.text);
      }
      transitionStatus('processing');
      setMessage(payload?.voiceCommandApplied && !payload?.text ? '已清空本次草稿' : '');
      return;
    }

    if (stage === 'preview_ready') {
      if (outputControlRef.current.interrupted) return;
      stopInitialLoadingTimer();
      setColdStartLoading(false);
      const hasPreviewTextUpdate = typeof payload?.text === 'string' || payload?.voiceCommandApplied === true;
      if (!fastInputModeRef.current && hasPreviewTextUpdate) {
        setAnimatedRealtimeTarget(payload.text || '', { immediate: true });
      }
      if (!fastInputModeRef.current) {
        transitionStatus('preview_ready');
        setMessage(payload?.message || '识别完成');
      }
    }
  }, [setAnimatedRealtimeTarget, startInitialLoadingTimer, stopInitialLoadingTimer, transitionStatus]);

  const reportExternalRecordingResult = useCallback((payload) => {
    window.electronAPI?.reportExternalRecordingResult?.(payload).catch((error) => {
      logRuntime("warn", "Failed to report external recording result", {
        error: error?.message || String(error),
      });
    });
  }, [logRuntime]);

  const startExternalRecording = useCallback(async (payload = {}) => {
    const sessionId = String(payload.session_id || "").trim();
    if (!sessionId) {
      return;
    }
    const externalMode = normalizeExternalRecordingMode(payload.intent || payload.mode);
    if (externalRealtimeSessionRef.current) {
      externalRealtimeSessionRef.current.cancel();
      externalRealtimeSessionRef.current = null;
    }
    externalPCMChunksRef.current = [];
    externalRecordingRef.current = {
      sessionId,
      mode: externalMode,
      sampleRate: Number(payload.sample_rate || 16000),
      startedAt: Date.now(),
      realtimeStartPromise: null,
      realtimeFailed: false,
      realtimeError: null,
      lastRealtimeTextLength: -1,
      latestRealtimePartial: null,
      cancelled: false,
      cancelReported: false,
    };

    recordingModeRef.current = "dictation";
    outputControlRef.current = {
      generation: outputControlRef.current.generation + 1,
      interrupted: false,
      reason: "",
    };
    pendingDictationConfirmRef.current = false;
    setAnimatedRealtimeTarget("", { immediate: true });
    setMessage("");
    setColdStartLoading(false);
    stopInitialLoadingTimer();
    await transitionStatus("recording");

    if (!isCyberRecordingMode(externalMode) && !modelStatus.isReady) {
      const message = modelStatus.isLoading ? "服务正在启动中，请稍候" : "模型未就绪";
      await transitionStatus("error");
      setMessage(message);
      reportExternalRecordingResult({
        session_id: sessionId,
        success: false,
        status: "start_failed",
        error: message,
      });
      return;
    }

    if (!isCyberRecordingMode(externalMode) && isRealtimeASRConfigured()) {
      const realtimeSession = new ExternalPCMRealtimeSession({
        sampleRate: externalRecordingRef.current.sampleRate,
        hotword: sessionHotwordsRef.current.join("\n"),
        optimizeMode: translateMode === "translate" ? "translate" : "none",
        translateTarget: translateTarget || "zh",
        onEvent: (event) => {
          const type = (event?.type || "").toLowerCase();
          const text = event?.text || event?.partial_text || event?.asr_text || "";
          const activeSession = externalRecordingRef.current;
          const shouldLogEvent = type !== "partial" || activeSession?.lastRealtimeTextLength !== text.length;
          if (type === "partial" && activeSession) {
            activeSession.lastRealtimeTextLength = text.length;
            if (text || event?.voice_command_applied === true) {
              activeSession.latestRealtimePartial = event;
            }
          }
          if (shouldLogEvent && ["ready", "partial", "final", "error", "closed"].includes(type)) {
            logRuntime(type === "error" ? "warn" : "info", "External M5 realtime event", {
              sessionId,
              type,
              textLength: text.length,
              requestId: event?.request_id || null,
              success: event?.success !== false,
              error: event?.error || event?.message || null,
            });
          }
          if (type === "ready") {
            handleTranscriptionProgress({
              stage: "realtime_ready",
              message: "",
              source: "external_m5",
            });
          } else if (type === "partial" && text) {
            handleTranscriptionProgress({
              stage: "recognizing",
              message: "识别中...",
              source: "realtime",
              text,
            });
          }
        },
        onClientEvent: (event) => {
          if (event?.type === "external_pcm_watchdog_stalled") {
            logRuntime("warn", "External M5 realtime PCM watchdog stalled; recording will fail on stop", event);
          }
        },
      });
      externalRealtimeSessionRef.current = realtimeSession;
      externalRecordingRef.current.realtimeStartPromise = realtimeSession.start().catch((error) => {
        externalRecordingRef.current.realtimeFailed = true;
        externalRecordingRef.current.realtimeError = error;
        logRuntime("warn", "External M5 realtime ASR unavailable; recording will fail on stop", {
          error: error?.message || String(error),
        });
        if (externalRealtimeSessionRef.current === realtimeSession) {
          externalRealtimeSessionRef.current = null;
        }
        realtimeSession.cancel();
      });
    }

    logRuntime("info", "External M5 recording started", {
      sessionId,
      sampleRate: externalRecordingRef.current.sampleRate,
    });
  }, [handleTranscriptionProgress, logRuntime, modelStatus.isLoading, modelStatus.isReady, reportExternalRecordingResult, setAnimatedRealtimeTarget, stopInitialLoadingTimer, transitionStatus, translateMode, translateTarget]);

  const receiveExternalRecordingChunk = useCallback((payload = {}) => {
    const sessionId = String(payload.session_id || "").trim();
    const session = externalRecordingRef.current;
    if (!session || session.sessionId !== sessionId) {
      return;
    }
    const chunk = payloadToArrayBuffer(payload.chunk);
    if (!chunk.byteLength) {
      return;
    }
    externalPCMChunksRef.current.push(chunk);
    if (externalRealtimeSessionRef.current) {
      externalRealtimeSessionRef.current.sendPCM(chunk);
    }
  }, []);

  const cancelExternalRecording = useCallback((payload = {}) => {
    const sessionId = String(payload.session_id || "").trim();
    const session = externalRecordingRef.current;
    if (!session || session.sessionId !== sessionId || session.cancelled) {
      return;
    }

    session.cancelled = true;
    if (externalRealtimeSessionRef.current) {
      externalRealtimeSessionRef.current.cancel();
      externalRealtimeSessionRef.current = null;
    }
    externalPCMChunksRef.current = [];
    cancelCurrentOutput(payload.reason || "m5_followup_cancel");
    if (!session.cancelReported) {
      session.cancelReported = true;
      reportExternalRecordingResult({
        session_id: sessionId,
        success: true,
        status: "cancelled",
        cancelled: true,
        message: "External M5 recording cancelled",
      });
    }
    if (externalRecordingRef.current === session) {
      externalRecordingRef.current = null;
    }
    logRuntime("info", "External M5 recording cancelled", { sessionId });
  }, [cancelCurrentOutput, logRuntime, reportExternalRecordingResult]);

  const stopExternalRecording = useCallback(async (payload = {}) => {
    const sessionId = String(payload.session_id || "").trim();
    const session = externalRecordingRef.current;
    if (!session || session.sessionId !== sessionId) {
      reportExternalRecordingResult({
        session_id: sessionId,
        success: false,
        status: "stop_failed",
        error: "External recording session not found",
      });
      return;
    }
    if (session.cancelled) {
      return;
    }

    try {
      stopInitialLoadingTimer();
      setColdStartLoading(false);
      handleTranscriptionProgress({ stage: "uploading_or_starting", message: "处理中..." });

      const chunks = externalPCMChunksRef.current.slice();
      if (!chunks.length) {
        throw new Error("M5 没有上传到音频数据");
      }
      const sampleRate = session.sampleRate || 16000;
      const stats = computePCMStats(chunks, sampleRate);
      const wavBlob = createWavBlobFromPCM(chunks, sampleRate);
      if (isCyberRecordingMode(session.mode)) {
        setAnimatedRealtimeTarget("", { immediate: true });
        await transitionStatus("completed");
        setMessage("已发送给赛博助手");
        reportExternalRecordingResult({
          session_id: sessionId,
          success: true,
          status: "cyber_audio_ready",
          mode: session.mode,
          intent: session.mode,
          text: "",
          audio_stats: stats,
          message: "External M5 cyber recording audio is ready",
        });
        logRuntime("info", "External M5 cyber recording audio ready", {
          sessionId,
          mode: session.mode,
          bytes: wavBlob.size,
          chunks: chunks.length,
          durationMs: stats.durationMs,
        });
        setTimeout(() => {
          resetUI();
          hideFloatingBall();
        }, 900);
        return;
      }
      let finalPayload = null;
      let realtimeError = session.realtimeError || null;
      let resultSource = "";

      if (session.realtimeStartPromise) {
        await session.realtimeStartPromise.catch(() => null);
      }
      if (session.cancelled) {
        return;
      }
      const realtimeSession = externalRealtimeSessionRef.current;
      if (realtimeSession) {
        if (realtimeSession.isPcmStalled?.()) {
          realtimeError = new Error("实时语音识别失败：发送到 18011 的 PCM 音频流已停滞");
        } else {
          const finishStartedAt = performance.now();
          try {
            finalPayload = await realtimeSession.finish({
              timeoutMs: computeRealtimeASRFinalTimeoutMs(stats.durationMs),
            });
            if (isUsableASRPayload(finalPayload)) {
              resultSource = "realtime_final";
              logRuntime("info", "External M5 realtime final settled", {
                sessionId,
                source: resultSource,
                elapsedMs: Math.round(performance.now() - finishStartedAt),
              });
            } else {
              realtimeError = new Error(
                finalPayload?.error
                  || finalPayload?.message
                  || "实时语音识别失败：18011 返回了不可用的最终结果"
              );
            }
          } catch (error) {
            realtimeError = error;
            logRuntime("warn", "External M5 realtime final failed", {
              sessionId,
              error: error?.message || String(error),
            });
          }
        }
      } else if (!realtimeError) {
        realtimeError = new Error("实时语音识别失败：没有可用的 18011 会话");
      }
      if (session.cancelled) {
        return;
      }

      if (!isUsableASRPayload(finalPayload)) {
        throw realtimeError || new Error("实时语音识别失败：18011 未返回可用结果");
      }
      if (session.cancelled) {
        return;
      }

      const transcriptionResult = normalizeASRPayload(finalPayload, wavBlob);
      transcriptionResult.audio_stats = transcriptionResult.audio_stats || stats;
      const hasUsableResult = isUsableASRPayload(transcriptionResult);
      logRuntime(hasUsableResult ? "info" : "warn", "External M5 ASR result selected", {
        sessionId,
        source: resultSource || "none",
        usable: hasUsableResult,
        textLength: extractASRText(transcriptionResult).length,
        voiceCommandApplied: transcriptionResult.voice_command_applied === true,
        requestId: transcriptionResult.request_id || null,
        error: hasUsableResult ? null : (realtimeError?.message || "No usable ASR result"),
      });
      await handleRecordingComplete(transcriptionResult);
      if (session.cancelled) {
        return;
      }
      reportExternalRecordingResult({
        session_id: sessionId,
        success: hasUsableResult,
        status: hasUsableResult ? "pasted" : "transcription_failed",
        text: transcriptionResult.text || transcriptionResult.asr_text || "",
        message: "External M5 recording handled by CapsWriter",
        error: hasUsableResult ? undefined : (realtimeError?.message || "No usable ASR result"),
      });
      logRuntime("info", "External M5 recording completed", {
        sessionId,
        bytes: wavBlob.size,
        chunks: chunks.length,
        durationMs: stats.durationMs,
        textLength: (transcriptionResult.text || "").length,
      });
    } catch (error) {
      if (session.cancelled) {
        return;
      }
      await transitionStatus("error");
      const message = error?.message || String(error);
      setMessage(`音频处理失败：${message}`);
      reportExternalRecordingResult({
        session_id: sessionId,
        success: false,
        status: "transcription_failed",
        error: message,
      });
      setTimeout(() => {
        resetUI();
        hideFloatingBall();
      }, 1600);
    } finally {
      if (externalRecordingRef.current === session) {
        if (externalRealtimeSessionRef.current) {
          externalRealtimeSessionRef.current.cancel();
          externalRealtimeSessionRef.current = null;
        }
        externalRecordingRef.current = null;
        externalPCMChunksRef.current = [];
      }
    }
  }, [handleRecordingComplete, handleTranscriptionProgress, hideFloatingBall, logRuntime, reportExternalRecordingResult, resetUI, setAnimatedRealtimeTarget, stopInitialLoadingTimer, transitionStatus, translateMode, translateTarget]);

  const handleAIOptimizationComplete = useCallback(() => {
  }, []);

  useEffect(() => {
    window.onTranscriptionComplete = handleRecordingComplete;
    window.onAIOptimizationComplete = handleAIOptimizationComplete;
    window.onTranscriptionProgress = handleTranscriptionProgress;

    return () => {
      window.onTranscriptionComplete = null;
      window.onAIOptimizationComplete = null;
      window.onTranscriptionProgress = null;
    };
  }, [handleRecordingComplete, handleAIOptimizationComplete, handleTranscriptionProgress]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    let cancelled = false;
    const loadRuntimeSettings = async () => {
      if (!window.electronAPI?.getSetting) {
        setTtsControlSyncReady(true);
        return;
      }
      try {
        const [savedMode, savedTarget, savedTtsEnabled, savedTtsSpeed, savedTtsSpeaker, savedTtsInstruction, savedReleaseGraceMs, savedFastInputMode, savedCapsMinHoldMs] = await Promise.all([
          window.electronAPI.getSetting(SETTING_VOICE_TRANSLATE_MODE, "transcribe"),
          window.electronAPI.getSetting(SETTING_VOICE_TRANSLATE_TARGET, "zh"),
          window.electronAPI.getSetting(SETTING_VOICE_TTS_ENABLED, false),
          window.electronAPI.getSetting(SETTING_VOICE_TTS_SPEED, DEFAULT_TTS_SPEED),
          window.electronAPI.getSetting(SETTING_VOICE_TTS_SPEAKER, ""),
          window.electronAPI.getSetting(SETTING_VOICE_TTS_INSTRUCTION, DEFAULT_TTS_INSTRUCTION),
          window.electronAPI.getSetting(SETTING_VOICE_RELEASE_GRACE_MS, DEFAULT_VOICE_RELEASE_GRACE_MS),
          window.electronAPI.getSetting(SETTING_VOICE_FAST_INPUT_MODE, true),
          window.electronAPI.getSetting(SETTING_CAPS_MIN_HOLD_MS, DEFAULT_CAPS_MIN_HOLD_MS)
        ]);
        if (cancelled) return;
        setTranslateMode(savedMode === "translate" ? "translate" : "transcribe");
        setTranslateTarget(savedTarget === "en" ? "en" : "zh");
        syncTtsEnabledState(!!savedTtsEnabled);
        const nextTtsSpeed = normalizeTtsSpeed(savedTtsSpeed);
        setTtsSpeed(nextTtsSpeed);
        ttsSpeedRef.current = nextTtsSpeed;
        const nextTtsSpeaker = String(savedTtsSpeaker || "").trim();
        setTtsSpeaker(nextTtsSpeaker);
        ttsSpeakerRef.current = nextTtsSpeaker;
        const nextTtsInstruction = String(savedTtsInstruction || DEFAULT_TTS_INSTRUCTION).trim();
        setTtsInstruction(nextTtsInstruction);
        ttsInstructionRef.current = nextTtsInstruction;
        setVoiceReleaseGraceMs(normalizeReleaseGraceMs(savedReleaseGraceMs));
        const nextFastInputMode = savedFastInputMode !== false;
        setFastInputMode(nextFastInputMode);
        fastInputModeRef.current = nextFastInputMode;
        const holdMs = Number.isFinite(Number(savedCapsMinHoldMs))
          ? Math.max(0, Number(savedCapsMinHoldMs))
          : DEFAULT_CAPS_MIN_HOLD_MS;
        window.electronAPI?.setCapsMinHoldMs?.(holdMs);
        setTtsControlSyncReady(true);
      } catch (error) {
        logRuntime("warn", "Failed to load runtime settings, fallback to defaults", {
          error: error?.message || String(error)
        });
        setTtsControlSyncReady(true);
      }
    };

    loadRuntimeSettings();
    return () => {
      cancelled = true;
    };
  }, [logRuntime, normalizeReleaseGraceMs, normalizeTtsSpeed, syncTtsEnabledState]);

  useEffect(() => {
    if (!ttsControlSyncReady) return;

    // 首次完成设置同步后，仅在开关为开时触发预加载；避免启动默认 false 时多余卸载请求。
    if (!ttsControlEffectInitializedRef.current) {
      ttsControlEffectInitializedRef.current = true;
      if (!ttsEnabled) return;
    }

    let cancelled = false;
    const syncTtsModelLifecycle = async () => {
      try {
        if (!(await isHttpBackendConfigured())) {
          return;
        }
        if (ttsEnabled) {
          const payload = await loadTtsModel({ wait: true, require_warmed: true });
          if (!cancelled) {
            logRuntime("info", "TTS model load requested", payload || {});
          }
          return;
        }
        const payload = await unloadTtsModel();
        if (!cancelled) {
          logRuntime("info", "TTS model unload requested", payload || {});
        }
      } catch (error) {
        if (!cancelled) {
          logRuntime("warn", ttsEnabled ? "Failed to request TTS model load" : "Failed to request TTS model unload", {
            error: error?.message || String(error)
          });
        }
      }
    };

    syncTtsModelLifecycle();
    return () => {
      cancelled = true;
    };
  }, [logRuntime, ttsControlSyncReady, ttsEnabled]);

  useEffect(() => {
    let cancelled = false;
    const syncTranslateLifecycle = async () => {
      try {
        if (!(await isHttpBackendConfigured())) {
          return;
        }
        if (translateMode === 'translate') {
          const payload = await loadService('translate');
          if (!cancelled) {
            logRuntime("info", "Translate service load requested", payload || {});
          }
          return;
        }

        const payload = await unloadService('translate');
        if (!cancelled) {
          logRuntime("info", "Translate service unload requested", payload || {});
        }
      } catch (error) {
        if (!cancelled) {
          logRuntime("warn", translateMode === 'translate' ? "Failed to request translate service load" : "Failed to request translate service unload", {
            error: error?.message || String(error)
          });
        }
      }
    };

    syncTranslateLifecycle();
    return () => {
      cancelled = true;
    };
  }, [logRuntime, translateMode]);

  useEffect(() => {
    if (!window.electronAPI?.onSettingsUpdate) return undefined;

    const unsubscribe = window.electronAPI.onSettingsUpdate((eventOrPayload, maybePayload) => {
      const payload = maybePayload && typeof maybePayload === "object"
        ? maybePayload
        : eventOrPayload;

      if (!payload || typeof payload !== "object") return;

      if (payload.reset) {
        setTranslateMode("transcribe");
        setTranslateTarget("zh");
        syncTtsEnabledState(false);
        setTtsSpeed(DEFAULT_TTS_SPEED);
        ttsSpeedRef.current = DEFAULT_TTS_SPEED;
        setTtsSpeaker(DEFAULT_TTS_SPEAKER);
        ttsSpeakerRef.current = DEFAULT_TTS_SPEAKER;
        setTtsInstruction(DEFAULT_TTS_INSTRUCTION);
        ttsInstructionRef.current = DEFAULT_TTS_INSTRUCTION;
        setVoiceReleaseGraceMs(DEFAULT_VOICE_RELEASE_GRACE_MS);
        setFastInputMode(true);
        fastInputModeRef.current = true;
        window.electronAPI?.setCapsMinHoldMs?.(DEFAULT_CAPS_MIN_HOLD_MS);
        return;
      }

      if (payload.key === SETTING_VOICE_TRANSLATE_MODE) {
        setTranslateMode(payload.value === "translate" ? "translate" : "transcribe");
      } else if (payload.key === SETTING_VOICE_TRANSLATE_TARGET) {
        setTranslateTarget(payload.value === "en" ? "en" : "zh");
      } else if (payload.key === SETTING_VOICE_TTS_ENABLED) {
        syncTtsEnabledState(!!payload.value);
      } else if (payload.key === SETTING_VOICE_TTS_SPEED) {
        const nextSpeed = normalizeTtsSpeed(payload.value);
        setTtsSpeed(nextSpeed);
        ttsSpeedRef.current = nextSpeed;
      } else if (payload.key === SETTING_VOICE_TTS_SPEAKER) {
        const nextSpeaker = String(payload.value || "").trim();
        setTtsSpeaker(nextSpeaker);
        ttsSpeakerRef.current = nextSpeaker;
      } else if (payload.key === SETTING_VOICE_TTS_INSTRUCTION) {
        const nextInstruction = String(payload.value || DEFAULT_TTS_INSTRUCTION).trim();
        setTtsInstruction(nextInstruction);
        ttsInstructionRef.current = nextInstruction;
      } else if (payload.key === SETTING_VOICE_RELEASE_GRACE_MS) {
        setVoiceReleaseGraceMs(normalizeReleaseGraceMs(payload.value));
      } else if (payload.key === SETTING_VOICE_FAST_INPUT_MODE) {
        const nextFastInputMode = payload.value !== false;
        setFastInputMode(nextFastInputMode);
        fastInputModeRef.current = nextFastInputMode;
      } else if (payload.key === SETTING_CAPS_MIN_HOLD_MS) {
        const holdMs = Number.isFinite(Number(payload.value))
          ? Math.max(0, Number(payload.value))
          : DEFAULT_CAPS_MIN_HOLD_MS;
        window.electronAPI?.setCapsMinHoldMs?.(holdMs);
      }
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [normalizeReleaseGraceMs, normalizeTtsSpeed, syncTtsEnabledState]);

  const startRecordingWithCheck = useCallback(async (mode = "dictation") => {
    if (pendingStopTimerRef.current) {
      clearTimeout(pendingStopTimerRef.current);
      pendingStopTimerRef.current = null;
      logRuntime("info", "Canceled pending stop on dictation hold key down");
    }
    recordingModeRef.current = mode === "codex" ? "codex" : "dictation";

    if (modelStatus.stage === 'need_download') {
      stopInitialLoadingTimer();
      setMessage("请先下载模型");
      return;
    }

    if (modelStatus.stage === 'downloading' || modelStatus.stage === 'loading') {
      startInitialLoadingTimer('model');
      setMessage("模型加载中");
      return;
    }

    if (modelStatus.stage === 'error') {
      stopInitialLoadingTimer();
      const errorText = String(modelStatus.error || '模型状态异常');
      setMessage(`模型错误：${errorText.length > 50 ? `${errorText.slice(0, 50)}...` : errorText}`);
      return;
    }

    if (!modelStatus.isReady) {
      stopInitialLoadingTimer();
      setMessage("模型未就绪");
      return;
    }

    outputControlRef.current = {
      generation: outputControlRef.current.generation + 1,
      interrupted: false,
      reason: "",
    };
    if (recordingModeRef.current === "codex") {
      window.electronAPI?.interruptMiniCPMVoice?.()
        .then((result) => {
          if (result && result.success === false) {
            logRuntime("warn", "MiniCPM voice interrupt before recording failed", {
              error: result.error || result.message || "unknown",
            });
          }
        })
        .catch((error) => {
          logRuntime("warn", "MiniCPM voice interrupt before recording failed", {
            error: error?.message || String(error),
          });
        });
    }
    stopCurrentTtsPlayback();
    abortActiveTtsRequests();
    logRuntime("info", "Stopped active TTS before recording", { mode: recordingModeRef.current });
    setAnimatedRealtimeTarget("", { immediate: true });
    setMessage(recordingModeRef.current === "codex" ? "窝窝头语音" : "");
    setColdStartLoading(false);
    stopInitialLoadingTimer();
    await transitionStatus("recording");
    const result = await startRecording({
      intentMode: "none",
      hotword: sessionHotwordsRef.current.join("\n"),
    });
    if (result?.started !== false) {
      return;
    }
    if (result.reason === "processing_previous") {
      await transitionStatus("processing");
      setMessage("正在完成上一句");
      return;
    }
    await transitionStatus("idle");
    setMessage("");
  }, [abortActiveTtsRequests, logRuntime, modelStatus, setAnimatedRealtimeTarget, startInitialLoadingTimer, startRecording, stopCurrentTtsPlayback, stopInitialLoadingTimer, transitionStatus]);

  const stopRecordingWithCheck = useCallback(() => {
    if (pendingStopTimerRef.current) {
      clearTimeout(pendingStopTimerRef.current);
      pendingStopTimerRef.current = null;
    }

    if (isRecording) {
      transitionStatus("processing");
      setMessage("");
      stopRecording();
      return;
    }

    // 非录音状态下松开按键，直接收起悬浮球
    resetUI();
    hideFloatingBall();
  }, [isRecording, stopRecording, transitionStatus, hideFloatingBall, resetUI]);

  const scheduleStopRecordingAfterRelease = useCallback(() => {
    if (pendingStopTimerRef.current) {
      clearTimeout(pendingStopTimerRef.current);
      pendingStopTimerRef.current = null;
    }

    const delayMs = normalizeReleaseGraceMs(voiceReleaseGraceMs);
    const stopSeq = ++stopRequestSeqRef.current;
    const requestedAt = Date.now();

    if (delayMs <= 0) {
      logRuntime("info", "Dictation hold key released, stopping recording immediately", {
        stopSeq,
        releaseGraceMs: 0
      });
      stopRecordingWithCheck();
      return;
    }

    logRuntime("info", "Dictation hold key released, schedule delayed stop", {
      stopSeq,
      releaseGraceMs: delayMs,
      isRecording: isRecordingRef.current
    });

    pendingStopTimerRef.current = setTimeout(() => {
      pendingStopTimerRef.current = null;
      logRuntime("info", "Executing delayed stop after release grace", {
        stopSeq,
        releaseGraceMs: delayMs,
        waitedMs: Date.now() - requestedAt,
        isRecording: isRecordingRef.current
      });
      stopRecordingWithCheck();
    }, delayMs);
  }, [logRuntime, normalizeReleaseGraceMs, stopRecordingWithCheck, voiceReleaseGraceMs]);

  useEffect(() => {
    if (window.electronAPI) {
      const unsubscribeDown = window.electronAPI.onCapsLockDown(() => {
        startRecordingWithCheck("dictation");
      });

      const unsubscribeUp = window.electronAPI.onCapsLockUp(() => {
        scheduleStopRecordingAfterRelease();
      });

      const unsubscribeCodexDown = window.electronAPI.onCodexHoldDown?.(() => {
        startRecordingWithCheck("codex");
      });

      const unsubscribeCodexUp = window.electronAPI.onCodexHoldUp?.(() => {
        scheduleStopRecordingAfterRelease();
      });

      return () => {
        if (unsubscribeDown) unsubscribeDown();
        if (unsubscribeUp) unsubscribeUp();
        if (unsubscribeCodexDown) unsubscribeCodexDown();
        if (unsubscribeCodexUp) unsubscribeCodexUp();
      };
    }
  }, [scheduleStopRecordingAfterRelease, startRecordingWithCheck]);

  useEffect(() => {
    if (!window.electronAPI) {
      return undefined;
    }
    const unsubscribeStart = window.electronAPI.onExternalRecordingStart?.((payload) => {
      startExternalRecording(payload).catch((error) => {
        reportExternalRecordingResult(payload?.session_id, "start_failed", {
          message: error?.message || "外部录音启动失败"
        });
      });
    });
    const unsubscribeChunk = window.electronAPI.onExternalRecordingChunk?.((payload) => {
      receiveExternalRecordingChunk(payload);
    });
    const unsubscribeStop = window.electronAPI.onExternalRecordingStop?.((payload) => {
      stopExternalRecording(payload).catch((error) => {
        reportExternalRecordingResult(payload?.session_id, "failed", {
          message: error?.message || "外部录音处理失败"
        });
      });
    });
    const unsubscribeCancel = window.electronAPI.onExternalRecordingCancel?.((payload) => {
      cancelExternalRecording(payload);
    });
    const unsubscribeError = window.electronAPI.onExternalRecordingError?.((payload) => {
      const message = payload?.error || payload?.message || "外部录音设备错误";
      transitionStatus("error");
      setMessage(message);
    });

    return () => {
      if (unsubscribeStart) unsubscribeStart();
      if (unsubscribeChunk) unsubscribeChunk();
      if (unsubscribeStop) unsubscribeStop();
      if (unsubscribeCancel) unsubscribeCancel();
      if (unsubscribeError) unsubscribeError();
    };
  }, [cancelExternalRecording, receiveExternalRecordingChunk, reportExternalRecordingResult, startExternalRecording, stopExternalRecording, transitionStatus]);

  useEffect(() => {
    if (!window.electronAPI?.onCodexVoiceUpdate) return undefined;

    const unsubscribe = window.electronAPI.onCodexVoiceUpdate((payload) => {
      if (!payload || typeof payload !== "object") return;
      const phase = String(payload.phase || "");
      const preview = sanitizeCodexFloatingPreview(payload.preview);
      const isCodexSurfacePhase = ["sent", "running", "completed", "error", "drafted"].includes(phase);
      if (isCodexSurfacePhase) {
        window.electronAPI?.setFloatingBallInputCaptureEnabled?.(true).catch(() => { });
      }

      if (phase !== "sent" && phase !== "running" && codexUpdateHideTimerRef.current) {
        clearTimeout(codexUpdateHideTimerRef.current);
        codexUpdateHideTimerRef.current = null;
      }

      if (phase === "error") {
        setAnimatedRealtimeTarget(preview, { immediate: true });
        setStatus("error");
        statusRef.current = "error";
        setMessage(`${payload.message || "Codex 语音任务失败"}。双击 Caps 关闭（Esc 备用）`);
        return;
      }

      if (phase === "completed") {
        setAnimatedRealtimeTarget(preview, { immediate: true });
        setStatus("completed");
        statusRef.current = "completed";
        setMessage(`${payload.message || "Codex 任务已完成"}。双击 Caps 关闭（Esc 备用）`);
        playCodexCompletionChime();
        return;
      }

      if (phase === "drafted") {
        setAnimatedRealtimeTarget("", { immediate: true });
        setStatus("completed");
        statusRef.current = "completed";
        setMessage(`${payload.message || "已放入 Codex Terminal，可校对后回车"}。双击 Caps 关闭（Esc 备用）`);
        return;
      }

      if (phase === "sent" || phase === "running") {
        setAnimatedRealtimeTarget("", { immediate: true });
        setStatus("optimizing");
        statusRef.current = "optimizing";
        setMessage(`${payload.message || (phase === "sent" ? "正在放入 Codex Terminal" : "Codex 正在执行，终端为主")}。双击 Caps 可中断（Esc 备用）`);
      }
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [playCodexCompletionChime, setAnimatedRealtimeTarget]);

  useEffect(() => {
    const isCodexSurfaceActive = recordingModeRef.current === "codex" && status !== "idle";
    const shouldCapture = DICTATION_CONTROL_STATUSES.includes(status) && recordingModeRef.current !== "codex";
    if (window.electronAPI?.setDictationKeyCaptureEnabled) {
      window.electronAPI.setDictationKeyCaptureEnabled(shouldCapture || isCodexSurfaceActive).catch(() => { });
    }
    if (window.electronAPI?.setFloatingBallInputCaptureEnabled) {
      window.electronAPI.setFloatingBallInputCaptureEnabled(shouldCapture || isCodexSurfaceActive).catch(() => { });
    }
    return undefined;
  }, [status]);

  useEffect(() => {
    if (!window.electronAPI) return undefined;

    const unsubscribeCancel = window.electronAPI.onDictationCancelRequested?.((payload = {}) => {
      const reason = payload?.reason || "global_escape";
      if (document.hasFocus() && reason !== "caps_double_press") {
        return;
      }
      const currentStatus = statusRef.current;
      if (recordingModeRef.current === "codex") {
        dismissCodexVoiceSurface(reason);
        return;
      }
      if (!DICTATION_CONTROL_STATUSES.includes(currentStatus)) {
        return;
      }
      cancelCurrentOutput(reason);
    });

    const unsubscribeConfirm = window.electronAPI.onDictationConfirmRequested?.(() => {
      if (document.hasFocus()) {
        return;
      }
      const currentStatus = statusRef.current;
      if (recordingModeRef.current === "codex" || !DICTATION_CONTROL_STATUSES.includes(currentStatus)) {
        return;
      }
      confirmCurrentOutput();
    });

    return () => {
      if (unsubscribeCancel) unsubscribeCancel();
      if (unsubscribeConfirm) unsubscribeConfirm();
      if (window.electronAPI?.setDictationKeyCaptureEnabled) {
        window.electronAPI.setDictationKeyCaptureEnabled(false).catch(() => { });
      }
      if (window.electronAPI?.setFloatingBallInputCaptureEnabled) {
        window.electronAPI.setFloatingBallInputCaptureEnabled(false).catch(() => { });
      }
    };
  }, [cancelCurrentOutput, confirmCurrentOutput, dismissCodexVoiceSurface]);

  useEffect(() => {
    const handleDictationKeyDown = (event) => {
      if (event.key === "Escape" && recordingModeRef.current === "codex") {
        event.preventDefault();
        event.stopPropagation();
        dismissCodexVoiceSurface("escape");
        return;
      }

      if (voiceLearningCandidateRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          skipVoiceLearningPrompt();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          confirmVoiceLearningPrompt();
          return;
        }
      }

      const currentStatus = statusRef.current;
      if (!DICTATION_CONTROL_STATUSES.includes(currentStatus)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelCurrentOutput("escape");
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        confirmCurrentOutput();
      }
    };

    window.addEventListener("keydown", handleDictationKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleDictationKeyDown, true);
    };
  }, [cancelCurrentOutput, confirmCurrentOutput, confirmVoiceLearningPrompt, dismissCodexVoiceSurface, skipVoiceLearningPrompt]);

  useEffect(() => {
    return () => {
      if (pendingStopTimerRef.current) {
        clearTimeout(pendingStopTimerRef.current);
        pendingStopTimerRef.current = null;
      }
      if (voiceLearningHideTimerRef.current) {
        clearTimeout(voiceLearningHideTimerRef.current);
        voiceLearningHideTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onClipboardTextChanged) return undefined;
    const unsubscribe = window.electronAPI.onClipboardTextChanged((payload) => {
      const normalized = String(payload?.text || '').trim();
      if (!normalized) return;
      if (Date.now() < suppressClipboardUntilRef.current) {
        logRuntime("info", "Clipboard change ignored during self-write suppression window", {
          textLength: normalized.length,
          suppressMsRemaining: suppressClipboardUntilRef.current - Date.now()
        });
        return;
      }
      const shouldProcess = ttsEnabledRef.current || translateModeRef.current === 'translate';
      if (!shouldProcess) {
        logRuntime("info", "Clipboard change ignored because TTS and Translate are disabled", {
          textLength: normalized.length
        });
        return;
      }
      if (normalized === lastClipboardTextRef.current) return;
      lastClipboardTextRef.current = normalized;
      logRuntime("info", "Clipboard change accepted for TTS/Translate", { textLength: normalized.length });
      playClipboardText(normalized, 'clipboard').catch(() => { });
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [logRuntime, playClipboardText]);

  useEffect(() => {
    return () => {
      if (window.electronAPI?.setClipboardWatchEnabled) {
        window.electronAPI.setClipboardWatchEnabled(false).catch(() => { });
      }
      ttsEnabledRef.current = false;
      setTtsEnabled(false);
      stopCurrentTtsPlayback();
      abortActiveTtsRequests();
    };
  }, [abortActiveTtsRequests, stopCurrentTtsPlayback]);

  useEffect(() => {
    if (recordingError) {
      setMessage(recordingError);
      transitionStatus("error");
      setTimeout(() => {
        resetUI();
        hideFloatingBall();
      }, 2000);
    }
  }, [recordingError, transitionStatus, hideFloatingBall, resetUI]);

  useEffect(() => {
    if (isRecordingProcessing) {
      transitionStatus("processing");
    }
  }, [isRecordingProcessing, transitionStatus]);

  useEffect(() => {
    if (isOptimizing) {
      transitionStatus("optimizing");
    }
  }, [isOptimizing, transitionStatus]);

  useEffect(() => {
    if (initialLoadingReason !== 'model') return;
    if (modelStatus.stage === 'downloading' || modelStatus.stage === 'loading') return;

    stopInitialLoadingTimer();
    if (modelStatus.isReady) {
      setMessage("");
    }
  }, [initialLoadingReason, modelStatus.stage, modelStatus.isReady, stopInitialLoadingTimer]);

  const syncFloatingBallSize = useCallback(() => {
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const contentHeight = Math.max(wrapperRef.current.scrollHeight, rect.height);
    const width = Math.ceil(rect.width + 20);
    const maxHeight = 640;
    const height = Math.ceil(Math.min(contentHeight + 18, maxHeight));
    resizeFloatingBall(width, height);
  }, [resizeFloatingBall]);

  useEffect(() => {
    const timer = setTimeout(syncFloatingBallSize, 0);
    return () => clearTimeout(timer);
  }, [syncFloatingBallSize, displayedRealtimeText, revisionParts, status, message, loadingElapsedSec]);

  useEffect(() => {
    if (!wrapperRef.current || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => syncFloatingBallSize());
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [syncFloatingBallSize]);

  useEffect(() => {
    const container = document.querySelector('.floating-ball-container');
    if (!container) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      container.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const handleMouseMove = (e) => {
      if (!isDragging) return;

      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;

      if (window.electronAPI && window.electronAPI.moveWindow) {
        window.electronAPI.moveWindow(deltaX, deltaY);
      }

      startX = e.screenX;
      startY = e.screenY;
    };

    const handleMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        container.style.cursor = 'move';
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const getStatusText = () => {
    if (message) return message;

    switch (status) {
      case "recording":
        return "正在录音";
      case "processing":
        return "正在识别";
      case "preview_ready":
        return "识别完成";
      case "pasting":
        return "正在粘贴";
      case "optimizing":
        return "正在整理";
      case "completed":
        return "完成";
      case "error":
        return "错误";
      default:
        return "就绪";
    }
  };

  const getStatusClass = () => {
    switch (status) {
      case "recording":
      case "processing":
        return "status-recording";
      case "preview_ready":
      case "pasting":
        return "status-processing";
      case "completed":
        return "status-completed";
      case "error":
        return "status-error";
      default:
        return "";
    }
  };

  const isPostReleaseLoadingStatus = ["processing", "pasting", "optimizing"].includes(status);
  const shouldShowLoadingDots = (status === "recording" || coldStartLoading || isPostReleaseLoadingStatus) && !displayedRealtimeText;
  const shouldShowInitialLoadingTimer = initialLoadingReason !== null && loadingElapsedSec !== null && !displayedRealtimeText;
  const shouldShowLoadingIndicator = shouldShowLoadingDots || shouldShowInitialLoadingTimer;
  const shouldShowStatusLabel = Boolean(message) && !coldStartLoading;
  const shouldShowPlaceholder = !displayedRealtimeText && !message && !shouldShowLoadingIndicator && status !== "recording" && !coldStartLoading;
  const shouldShowTextContainer = Boolean(displayedRealtimeText) || shouldShowLoadingIndicator || shouldShowStatusLabel || shouldShowPlaceholder || coldStartLoading;
  const shouldShowRecordingDot = ["recording", "processing"].includes(status);
  const renderStatusDots = () => (
    <span className="status-dots" aria-label="处理中">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
  const renderLoadingIndicator = () => (
    <div className="loading-indicator" aria-label={shouldShowInitialLoadingTimer ? `加载中 ${loadingElapsedSec} 秒` : "处理中"}>
      {renderStatusDots()}
      {shouldShowInitialLoadingTimer && (
        <span className="loading-elapsed">{loadingElapsedSec}s</span>
      )}
    </div>
  );

  return (
    <div className="floating-ball-container">
      <div className={`floating-ball-wrapper ${shouldShowTextContainer ? "" : "is-icon-only"}`} ref={wrapperRef}>
        <div className={`floating-ball ${getStatusClass()}`}>
          {shouldShowRecordingDot ? (
            <div className="recording-indicator"></div>
          ) : (
            <img className="ball-icon" src={appLogoUrl} alt="" aria-hidden="true" />
          )}
        </div>
        {shouldShowTextContainer && (
          <div className="text-container">
            {shouldShowStatusLabel && (
              <span className="status-label">
                {getStatusText()}
              </span>
            )}
            {displayedRealtimeText ? (
              <p
                ref={recognizedTextRef}
                className={`recognized-text ${revisionParts.length > 0 ? "has-revisions" : ""} ${status === "recording" || status === "processing" || status === "preview_ready" ? "is-typing" : ""}`}
              >
                {revisionParts.length > 0
                  ? revisionParts.map(part => (
                    <span
                      key={part.key}
                      className={`revision-token revision-token-${part.type}`}
                    >
                      {part.displayText ?? part.text}
                    </span>
                  ))
                  : displayedRealtimeText}
              </p>
            ) : shouldShowLoadingIndicator ? (
              renderLoadingIndicator()
            ) : shouldShowPlaceholder ? (
              <p className="placeholder-text">
                按住 Right Shift
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
