import { useState, useRef, useCallback, useEffect } from 'react';
import { useModelStatus } from './useModelStatus';
import {
  RealtimeASRSession,
  computeRealtimeASRFinalTimeoutMs,
  isRealtimeASRConfigured,
  translateText,
} from '../services/backendAPI.js';
import {
  buildSystemDefaultAudioCaptureProfiles,
  stopMediaStreamTracks,
} from '../helpers/audioCapturePolicy.mjs';
import { isKnownSilentASRArtifactWithHotwords } from '../helpers/silentAsrArtifacts.js';
import {
  extractASRText,
  selectRealtimeFinalTimeoutFallback,
} from '../helpers/asrResultPolicy.mjs';

const ACTIVE_SAMPLE_THRESHOLD = 0.0025;
const SILENCE_PEAK_THRESHOLD = 0.0015;
const SILENCE_RMS_THRESHOLD = 0.00035;
const MIN_ACTIVE_RATIO = 0.003;
const MEDIA_RECORDER_TIMESLICE_MS = 250;
const MEDIA_RECORDER_STOP_DRAIN_MS = 120;
const RECORDING_START_TIMEOUT_MS = 2500;
const REALTIME_STOP_CONNECT_GRACE_MS = 3500;

function roundMetric(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function computeAudioStats(samples, sampleRate) {
  const totalSamples = samples.length;
  if (!totalSamples) {
    return {
      sampleRate,
      chunkCount: 0,
      totalSamples: 0,
      durationMs: 0,
      durationSec: 0,
      bufferSize: null,
      peakAbs: 0,
      rms: 0,
      activeSamples: 0,
      activeRatio: 0,
    };
  }

  let peakAbs = 0;
  let sumSquares = 0;
  let activeSamples = 0;
  for (let i = 0; i < totalSamples; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peakAbs) {
      peakAbs = abs;
    }
    sumSquares += samples[i] * samples[i];
    if (abs >= ACTIVE_SAMPLE_THRESHOLD) {
      activeSamples += 1;
    }
  }

  const durationSec = totalSamples / sampleRate;
  const rms = Math.sqrt(sumSquares / totalSamples);
  return {
    sampleRate,
    chunkCount: 0,
    totalSamples,
    durationMs: Math.round(durationSec * 1000),
    durationSec: roundMetric(durationSec, 3),
    bufferSize: null,
    peakAbs: roundMetric(peakAbs),
    rms: roundMetric(rms),
    activeSamples,
    activeRatio: roundMetric(activeSamples / totalSamples),
  };
}

function isSilentRecording(stats) {
  if (!stats || stats.totalSamples === 0) {
    return true;
  }
  return (
    stats.peakAbs < SILENCE_PEAK_THRESHOLD &&
    stats.rms < SILENCE_RMS_THRESHOLD &&
    stats.activeRatio < MIN_ACTIVE_RATIO
  );
}

function scheduleBackgroundTask(task) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(task, { timeout: 1500 });
    return;
  }
  window.setTimeout(task, 0);
}

function queueVoiceDatasetSample({
  audioBlob,
  transcriptionResult,
  rawText,
  localAudioStats,
  mode,
  translateTarget,
  hotword,
  source,
  log,
}) {
  const recordSample = window.electronAPI?.recordVoiceDatasetSample;
  if (typeof recordSample !== 'function' || !audioBlob) {
    return;
  }

  scheduleBackgroundTask(() => {
    audioBlob.arrayBuffer()
      .then((audioBuffer) => recordSample({
        audio: audioBuffer,
        audioMimeType: audioBlob.type || 'audio/wav',
        source,
        mode,
        translate_target: translateTarget,
        hotword,
        request_id: transcriptionResult?.request_id || '',
        text: rawText || transcriptionResult?.text || '',
        final_text: transcriptionResult?.text || rawText || '',
        asr_text: transcriptionResult?.asr_text || '',
        raw_asr_text: transcriptionResult?.raw_asr_text || '',
        duration: transcriptionResult?.duration || localAudioStats?.durationSec || 0,
        language: transcriptionResult?.language || 'zh-CN',
        confidence: transcriptionResult?.confidence || 0,
        postprocess_mode: transcriptionResult?.postprocess_mode || 'none',
        voice_command_applied: transcriptionResult?.voice_command_applied === true,
        voice_command_type: transcriptionResult?.voice_command_type || '',
        voice_intent_id: transcriptionResult?.voice_intent_id || '',
        local_audio_stats: localAudioStats || {},
        server_audio_stats: transcriptionResult?.audio_stats || {},
        result_payload: transcriptionResult || {},
      }))
      .then((result) => {
        if (result?.success === false && result?.error !== 'empty_audio') {
          log?.('warn', 'Voice dataset sample was not recorded', result);
        }
      })
      .catch((error) => {
        log?.('warn', 'Voice dataset sample record failed', {
          error: error?.message || String(error),
        });
      });
  });
}

async function listAudioInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId || '',
      label: device.label || '',
    }));
}

async function requestMicrophoneStream() {
  const availableInputs = await listAudioInputDevices();
  const profiles = buildSystemDefaultAudioCaptureProfiles();
  const failures = [];

  for (const profile of profiles) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(profile.constraints);
      return {
        stream,
        profile: profile.name,
        availableInputs,
      };
    } catch (error) {
      failures.push({
        profile: profile.name,
        error: error?.message || String(error),
      });
    }
  }

  const detail = failures.map((item) => `${item.profile}: ${item.error}`).join('; ');
  throw new Error(detail || '无法获取麦克风输入流');
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  });
}

function getPreferredMediaRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported?.(mimeType)) || '';
}

async function decodeAudioBlobStats(blob) {
  if (!blob || blob.size === 0) {
    return computeAudioStats(new Float32Array(0), 0);
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return {
      sampleRate: 0,
      chunkCount: 0,
      totalSamples: 0,
      durationMs: 0,
      durationSec: 0,
      bufferSize: null,
      peakAbs: 0,
      rms: 0,
      activeSamples: 0,
      activeRatio: 0,
      decodeError: 'AudioContext unavailable',
    };
  }

  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContextCtor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const channelData = audioBuffer.numberOfChannels > 0
      ? audioBuffer.getChannelData(0)
      : new Float32Array(0);
    return computeAudioStats(channelData, audioBuffer.sampleRate);
  } catch (error) {
    return {
      sampleRate: 0,
      chunkCount: 0,
      totalSamples: 0,
      durationMs: 0,
      durationSec: 0,
      bufferSize: null,
      peakAbs: 0,
      rms: 0,
      activeSamples: 0,
      activeRatio: 0,
      decodeError: error?.message || String(error),
    };
  } finally {
    await audioContext.close().catch(() => {});
  }
}

class StreamRecorder {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || '';
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.dataEventCount = 0;
    this.isRecording = false;
  }

  async start() {
    this.audioChunks = [];
    this.dataEventCount = 0;
    this.isRecording = true;
    this.mediaRecorder = this.mimeType
      ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
      : new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (event) => {
      this.dataEventCount += 1;
      if (event.data && event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };
    this.mediaRecorder.start(MEDIA_RECORDER_TIMESLICE_MS);
  }

  async stop() {
    this.isRecording = false;
    if (!this.mediaRecorder) {
      return {
        audioBlob: new Blob([], { type: this.mimeType || 'application/octet-stream' }),
        stats: await decodeAudioBlobStats(new Blob([], { type: this.mimeType || 'application/octet-stream' })),
      };
    }

    const recorder = this.mediaRecorder;
    const blob = await new Promise((resolve, reject) => {
      recorder.onstop = () => {
        window.setTimeout(() => {
          resolve(new Blob(this.audioChunks, { type: recorder.mimeType || this.mimeType || 'audio/webm' }));
        }, MEDIA_RECORDER_STOP_DRAIN_MS);
      };
      recorder.onerror = (event) => {
        reject(event?.error || new Error('MediaRecorder failed'));
      };
      if (recorder.state === 'inactive') {
        resolve(new Blob(this.audioChunks, { type: recorder.mimeType || this.mimeType || 'audio/webm' }));
        return;
      }
      if (typeof recorder.requestData === 'function') {
        try {
          recorder.requestData();
        } catch {
          // 某些 Electron/Chromium 组合在 stop 前 requestData 可能抛错，忽略即可。
        }
      }
      recorder.stop();
    });

    const stats = await decodeAudioBlobStats(blob);
    return {
      audioBlob: blob,
      stats: {
        ...stats,
        chunkCount: this.audioChunks.length,
        dataEventCount: this.dataEventCount,
      },
    };
  }
}

export const useRecording = ({ translateMode = 'transcribe', translateTarget = 'zh' } = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const isOptimizing = false;
  const [error, setError] = useState(null);
  const [audioData, setAudioData] = useState(null);

  const wavRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const recordingSessionRef = useRef(0);
  const recordStartAtRef = useRef(0);
  const captureDiagnosticsRef = useRef(null);
  const isRecordingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isFinalizingRef = useRef(false);
  const pendingStartRef = useRef(null);
  const realtimeSessionRef = useRef(null);
  const realtimeStartPromiseRef = useRef(null);
  const realtimeStartErrorRef = useRef(null);
  const recordingClientIntentRef = useRef({
    intentMode: 'none',
    clientIntents: [],
    clientIntentConfidenceThreshold: 0.78,
  });
  const recordingHotwordRef = useRef('');
  const modelStatus = useModelStatus();

  const logRecordingDebug = useCallback((level, message, data = null) => {
    if (window.electronAPI?.log) {
      window.electronAPI.log(level, message, data).catch(() => {});
      return;
    }
    const logger = console[level] || console.log;
    logger(message, data ?? '');
  }, []);

  const resolveClientIntentPayload = useCallback(async (options = {}) => {
    if (options.intentMode !== 'client_intent') {
      return {
        intentMode: 'none',
        clientIntents: [],
        clientIntentConfidenceThreshold: 0.78,
      };
    }
    const getManifest = window.electronAPI?.getVoiceActionIntentManifest;
    if (typeof getManifest !== 'function') {
      return {
        intentMode: 'none',
        clientIntents: [],
        clientIntentConfidenceThreshold: 0.78,
      };
    }
    try {
      const manifest = await getManifest();
      const clientIntents = Array.isArray(manifest?.intents) ? manifest.intents : [];
      if (!clientIntents.length) {
        return {
          intentMode: 'none',
          clientIntents: [],
          clientIntentConfidenceThreshold: 0.78,
        };
      }
      return {
        intentMode: 'client_intent',
        clientIntents,
        clientIntentConfidenceThreshold: Number.isFinite(Number(manifest?.confidenceThreshold))
          ? Number(manifest.confidenceThreshold)
          : 0.78,
      };
    } catch (error) {
      logRecordingDebug('warn', 'Failed to load client intent manifest', {
        error: error?.message || String(error),
      });
      return {
        intentMode: 'none',
        clientIntents: [],
        clientIntentConfidenceThreshold: 0.78,
      };
    }
  }, [logRecordingDebug]);

  const stopMediaStream = useCallback((stream) => {
    stopMediaStreamTracks(stream);
  }, []);

  const acquireMicrophoneStream = useCallback(async () => {
    return requestMicrophoneStream();
  }, []);

  const releaseMicrophoneStream = useCallback((stream, reason) => {
    if (!stream) {
      return;
    }
    stopMediaStream(stream);
    logRecordingDebug('info', 'Microphone stream released', { reason });
  }, [logRecordingDebug, stopMediaStream]);

  const abortPendingStart = useCallback((reason) => {
    const pending = pendingStartRef.current;
    if (!pending) {
      return false;
    }

    pending.canceled = true;
    releaseMicrophoneStream(pending.stream, reason);
    if (streamRef.current === pending.stream) {
      streamRef.current = null;
    }
    if (wavRecorderRef.current === pending.recorder) {
      wavRecorderRef.current = null;
    }
    if (realtimeSessionRef.current) {
      realtimeSessionRef.current.cancel();
      realtimeSessionRef.current = null;
    }
    realtimeStartPromiseRef.current = null;
    pendingStartRef.current = null;
    isStartingRef.current = false;
    isRecordingRef.current = false;

    logRecordingDebug('info', 'Pending recording start aborted', { reason });
    return true;
  }, [logRecordingDebug, releaseMicrophoneStream]);

  const startRecording = useCallback(async (options = {}) => {
    if (isFinalizingRef.current) {
      logRecordingDebug('info', 'Ignore recording start while previous transcription is finalizing');
      return { started: false, reason: 'processing_previous' };
    }
    if (isStartingRef.current || isRecordingRef.current) {
      logRecordingDebug('warn', 'Ignore duplicate recording start request', {
        isStarting: isStartingRef.current,
        isRecording: isRecordingRef.current,
      });
      return;
    }

    const pendingStart = {
      canceled: false,
      stream: null,
      recorder: null,
    };

    try {
      setError(null);

      if (!modelStatus.isReady) {
        if (modelStatus.isLoading) {
          throw new Error('服务正在启动中，请稍候...');
        } else if (modelStatus.error) {
          throw new Error('服务未就绪，请检查后端配置');
        } else {
          throw new Error('正在准备服务，请稍候...');
        }
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('当前浏览器不支持录音功能');
      }
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('当前浏览器不支持 MediaRecorder 录音');
      }

      isStartingRef.current = true;
      const clientIntentPayload = await resolveClientIntentPayload(options);
      recordingClientIntentRef.current = clientIntentPayload;
      recordingHotwordRef.current = String(options.hotword || '');
      isRecordingRef.current = true;
      pendingStartRef.current = pendingStart;
      setIsRecording(true);

      logRecordingDebug('info', 'Request microphone stream started', {
        timeoutMs: RECORDING_START_TIMEOUT_MS,
      });

      const microphoneRequestStartedAt = performance.now();
      const { stream, profile, availableInputs } = await withTimeout(
        acquireMicrophoneStream(),
        RECORDING_START_TIMEOUT_MS,
        `麦克风启动超时（>${RECORDING_START_TIMEOUT_MS}ms）`
      );
      pendingStart.stream = stream;
      if (pendingStart.canceled || pendingStartRef.current !== pendingStart) {
        releaseMicrophoneStream(stream, 'start_canceled_after_stream');
        return;
      }

      logRecordingDebug('info', 'Request microphone stream resolved', {
        captureProfile: profile,
        elapsedMs: Math.round(performance.now() - microphoneRequestStartedAt),
      });

      const [track] = stream.getAudioTracks();
      const trackSettings = typeof track?.getSettings === 'function' ? track.getSettings() : {};
      const trackConstraints = typeof track?.getConstraints === 'function' ? track.getConstraints() : {};
      const mimeType = getPreferredMediaRecorderMimeType();

      captureDiagnosticsRef.current = {
        captureProfile: profile,
        availableAudioInputs: availableInputs,
        recorderMimeType: mimeType || 'system-default',
        trackLabel: track?.label || 'unknown',
        trackMutedAtStart: Boolean(track?.muted),
        trackReadyState: track?.readyState || 'unknown',
        trackSettings,
        trackConstraints,
      };

      streamRef.current = stream;

      if (isRealtimeASRConfigured()) {
        realtimeStartErrorRef.current = null;
        const currentMode = translateMode === 'translate' ? 'translate' : 'transcribe';
        const realtimeSession = new RealtimeASRSession(stream, {
          hotword: recordingHotwordRef.current,
          optimizeMode: currentMode === 'translate' ? 'translate' : 'none',
          translateTarget: translateTarget || 'zh',
          intentMode: clientIntentPayload.intentMode,
          clientIntents: clientIntentPayload.clientIntents,
          clientIntentConfidenceThreshold: clientIntentPayload.clientIntentConfidenceThreshold,
          onEvent: (event) => {
            const type = (event?.type || '').toLowerCase();
            const text = event?.text || event?.partial_text || event?.asr_text || '';
            const displayText = isKnownSilentASRArtifactWithHotwords(recordingHotwordRef.current, text) ? '' : text;
            const voiceCommandApplied = event?.voice_command_applied === true;
            const diagnostics = captureDiagnosticsRef.current;
            const shouldLogEvent = type !== 'partial'
              || diagnostics?.lastRealtimeTextLength !== displayText.length;
            if (type === 'partial' && diagnostics) {
              diagnostics.lastRealtimeTextLength = displayText.length;
            }
            if (shouldLogEvent && ['ready', 'partial', 'final', 'error', 'closed'].includes(type)) {
              logRecordingDebug(type === 'error' ? 'warn' : 'info', 'Realtime ASR event', {
                sessionId: recordingSessionRef.current,
                type,
                textLength: displayText.length,
                requestId: event?.request_id || null,
                success: event?.success !== false,
                error: event?.error || event?.message || null,
              });
            }
            if (type === 'loading' && event?.cold_start && window.onTranscriptionProgress) {
              window.onTranscriptionProgress({
                stage: 'cold_start_loading',
                message: event?.message || '模型冷启动中',
                source: 'realtime',
                coldStart: true,
              });
            }
            if (type === 'ready' && window.onTranscriptionProgress) {
              window.onTranscriptionProgress({
                stage: 'realtime_ready',
                message: '',
                source: 'realtime',
              });
            }
            if (type === 'partial' && (displayText || voiceCommandApplied) && window.onTranscriptionProgress) {
              window.onTranscriptionProgress({
                stage: 'recognizing',
                message: '识别中...',
                source: 'realtime',
                text: displayText,
                voiceCommandApplied,
                voiceCommandType: event?.voice_command_type || '',
              });
            }
          },
          onClientEvent: (event) => {
            if (event?.type === 'preroll_flushed') {
              logRecordingDebug('info', 'Realtime ASR preroll flushed', event);
            } else if (event?.type === 'realtime_pcm_watchdog_stalled') {
              logRecordingDebug('warn', 'Realtime ASR PCM watchdog stalled; recording will fail on stop', event);
            }
          },
        });
        realtimeSessionRef.current = realtimeSession;
        realtimeStartPromiseRef.current = realtimeSession.start().catch((error) => {
          realtimeStartErrorRef.current = error;
          logRecordingDebug('warn', 'Realtime ASR unavailable, will mark recording failed on stop', {
            error: error?.message || String(error),
          });
          if (realtimeSessionRef.current === realtimeSession) {
            realtimeSessionRef.current = null;
          }
          realtimeSession.cancel();
        });
      }

      const recorder = new StreamRecorder(stream, { mimeType });
      pendingStart.recorder = recorder;
      wavRecorderRef.current = recorder;
      await recorder.start();
      if (pendingStart.canceled || pendingStartRef.current !== pendingStart) {
        try {
          await recorder.stop();
        } catch {
          // 录音器可能尚未进入可停止状态，忽略即可。
        }
        releaseMicrophoneStream(stream, 'start_canceled_after_recorder');
        if (wavRecorderRef.current === recorder) {
          wavRecorderRef.current = null;
        }
        if (streamRef.current === stream) {
          streamRef.current = null;
        }
        return;
      }

      recordingSessionRef.current += 1;
      recordStartAtRef.current = Date.now();
      logRecordingDebug('info', 'Recording started', {
        sessionId: recordingSessionRef.current,
        ...captureDiagnosticsRef.current,
      });
    } catch (err) {
      abortPendingStart('start_failed');
      setError(`无法开始录音：${err.message}`);
      setIsRecording(false);
      isRecordingRef.current = false;
    }
    finally {
      if (pendingStartRef.current === pendingStart) {
        pendingStartRef.current = null;
      }
      isStartingRef.current = false;
    }
  }, [abortPendingStart, acquireMicrophoneStream, logRecordingDebug, modelStatus.isReady, modelStatus.isLoading, modelStatus.error, releaseMicrophoneStream, resolveClientIntentPayload, translateMode, translateTarget]);

  const processAudio = useCallback(async (audioBlob, localAudioStats, realtimePayload = null) => {
    const emitProgress = (payload) => {
      if (window.onTranscriptionProgress) {
        window.onTranscriptionProgress(payload);
      }
    };

    try {
      setAudioData(audioBlob);
      emitProgress({ stage: 'uploading_or_starting', message: '处理中...' });

      if (!audioBlob || audioBlob.size === 0) {
        const message = '录音为空，系统默认麦克风没有产出音频，请检查输入设备和权限。';
        logRecordingDebug('warn', 'Skip ASR for empty recording', {
          message,
          localAudioStats,
          ...captureDiagnosticsRef.current,
        });
        throw new Error(message);
      }

      if (isSilentRecording(localAudioStats)) {
        const message = '未检测到麦克风输入，本次录音已忽略';
        logRecordingDebug('warn', 'Skip ASR for silent recording', {
          message,
          localAudioStats,
          ...captureDiagnosticsRef.current,
        });
        throw new Error(message);
      }

      let transcriptionResult = null;
      const currentMode = translateMode === 'translate' ? 'translate' : 'transcribe';
      const currentTarget = translateTarget || 'zh';
      const hotword = recordingHotwordRef.current || '';

      try {
        if (!realtimePayload) {
          throw new Error('实时语音识别失败：未收到 18011 的最终结果');
        }
        const streamDonePayload = realtimePayload;
        const recognizedText = extractASRText(streamDonePayload);

        transcriptionResult = {
          success: streamDonePayload?.success !== false,
          text: recognizedText,
          asr_text:
            streamDonePayload?.asr_text ||
            streamDonePayload?.text ||
            streamDonePayload?.partial_text ||
            recognizedText,
          raw_asr_text: streamDonePayload?.raw_asr_text || '',
          duration: streamDonePayload?.duration || streamDonePayload?.timing?.audio_duration_s || 0,
          language: streamDonePayload?.language || 'zh-CN',
          confidence: streamDonePayload?.confidence || 0.95,
          request_id: streamDonePayload?.request_id,
          audio_stats: streamDonePayload?.audio_stats || null,
          postprocess_mode: streamDonePayload?.postprocess_mode || 'none',
          translation_success: streamDonePayload?.translation_success,
          translation_error: streamDonePayload?.translation_error,
          voice_command_applied: streamDonePayload?.voice_command_applied === true,
          voice_command_type: streamDonePayload?.voice_command_type || '',
          voice_command_phrase: streamDonePayload?.voice_command_phrase || '',
          voice_command_source: streamDonePayload?.voice_command_source || '',
          voice_command_confidence: streamDonePayload?.voice_command_confidence,
          voice_intent_id: streamDonePayload?.voice_intent_id || '',
          voice_intent_source: streamDonePayload?.voice_intent_source || '',
          voice_intent_confidence: streamDonePayload?.voice_intent_confidence,
          voice_intent_reason: streamDonePayload?.voice_intent_reason || '',
          voice_intent_action_type: streamDonePayload?.voice_intent_action_type || '',
        };

        const asrTextForTranslate = (transcriptionResult.asr_text || transcriptionResult.text || '').trim();
        const currentText = (transcriptionResult.text || '').trim();
        const shouldClientTranslate =
          currentMode === 'translate' &&
          !transcriptionResult.voice_command_applied &&
          asrTextForTranslate &&
          (
            transcriptionResult.translation_success === false ||
            !currentText ||
            currentText === asrTextForTranslate
          );
        if (shouldClientTranslate) {
          try {
            const translated = await translateText(asrTextForTranslate, currentTarget, {
              traceId: `recording-${streamDonePayload?.request_id || Date.now()}`
            });
            const translatedText = (translated?.translated_text || '').trim();
            if (translatedText) {
              transcriptionResult.text = translatedText;
              transcriptionResult.translated_text = translatedText;
              transcriptionResult.postprocess_mode = 'translate';
              transcriptionResult.translation_success = true;
              transcriptionResult.translation_error = null;
            }
          } catch (translateError) {
            transcriptionResult.translation_success = false;
            transcriptionResult.translation_error = translateError?.message || String(translateError);
            logRecordingDebug('warn', 'Client-side translate fallback failed', {
              target: currentTarget,
              error: transcriptionResult.translation_error,
            });
          }
        }
      } catch (streamErr) {
        console.warn('Realtime transcription failed:', streamErr);
        throw streamErr;
      }

      const ok = transcriptionResult && transcriptionResult.success !== false;
      if (!ok) {
        const message = transcriptionResult?.error || '语音识别失败';
        throw new Error(message);
      }

      let rawText = transcriptionResult.text || transcriptionResult.transcript || '';
      const durationSec = transcriptionResult.duration || 0;
      const language = transcriptionResult.language || 'zh-CN';
      const confidence = transcriptionResult.confidence || 0;
      const serverAudioStats = transcriptionResult.audio_stats || null;
      const silentArtifactDetected = isKnownSilentASRArtifactWithHotwords(
        hotword,
        rawText,
        transcriptionResult.asr_text,
        transcriptionResult.raw_asr_text
      );

      if (silentArtifactDetected && !transcriptionResult.voice_command_applied) {
        const message = 'ASR 返回静音伪文本，已忽略本次录音';
        logRecordingDebug('warn', 'ASR returned known silent artifact', {
          message,
          rawText,
          asrText: transcriptionResult.asr_text || '',
          rawAsrText: transcriptionResult.raw_asr_text || '',
          localAudioStats,
          serverAudioStats,
        });
        throw new Error(message);
      }
      if (silentArtifactDetected) {
        logRecordingDebug('warn', 'ASR returned known silent artifact for voice command, stripping display text', {
          rawText,
          asrText: transcriptionResult.asr_text || '',
          rawAsrText: transcriptionResult.raw_asr_text || '',
          localAudioStats,
          serverAudioStats,
        });
        rawText = '';
        transcriptionResult = {
          ...transcriptionResult,
          text: '',
          transcript: '',
          asr_text: '',
          raw_asr_text: '',
        };
      }

      logRecordingDebug('info', 'Transcription completed', {
        mode: currentMode,
        durationSec,
        textLength: rawText.length,
        asrTextLength: (transcriptionResult.asr_text || '').length,
        resultTail: rawText.slice(-20),
        asrTail: (transcriptionResult.asr_text || '').slice(-20),
        localAudioStats,
        serverAudioStats,
      });

      if (!rawText.trim() && !transcriptionResult.voice_command_applied) {
        const silentInput = isSilentRecording(localAudioStats);
        const message = silentInput
          ? '未检测到麦克风输入，请检查系统默认输入设备或麦克风权限'
          : 'ASR 返回空文本，请查看日志中的录音统计和 audio_stats';
        logRecordingDebug('warn', 'ASR returned empty text', {
          message,
          silentInput,
          localAudioStats,
          serverAudioStats,
          ...captureDiagnosticsRef.current,
        });
        throw new Error(message);
      }

      emitProgress({
        stage: 'preview_ready',
        message: transcriptionResult.voice_command_applied && !rawText.trim()
          ? (transcriptionResult.voice_command_type === 'client_intent' ? '已识别语音指令' : '已清空本次草稿')
          : '识别完成',
        text: rawText,
        voiceCommandApplied: transcriptionResult.voice_command_applied,
        voiceCommandType: transcriptionResult.voice_command_type,
        voiceIntentId: transcriptionResult.voice_intent_id,
      });

      const transcriptionData = {
        raw_text: rawText,
        text: rawText,
        confidence,
        language,
        duration: durationSec,
        file_size: audioBlob.size,
      };

      if (window.onTranscriptionComplete) {
        window.onTranscriptionComplete({
          ...transcriptionResult,
          enhanced_by_ai:
            !!transcriptionResult?.postprocess_mode &&
            transcriptionResult.postprocess_mode !== 'none',
        });
      }

      queueVoiceDatasetSample({
        audioBlob,
        transcriptionResult,
        rawText,
        localAudioStats,
        mode: currentMode,
        translateTarget: currentTarget,
        hotword,
        source: 'client_realtime',
        log: logRecordingDebug,
      });

      if (window.electronAPI && rawText.trim()) {
        window.electronAPI.saveTranscription(transcriptionData).catch(() => {});
      }
    } catch (err) {
      setError(`音频处理失败：${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [logRecordingDebug, translateMode, translateTarget]);

  const stopRecording = useCallback(() => {
    if (isStartingRef.current && !wavRecorderRef.current) {
      abortPendingStart('stop_before_recorder_ready');
      setError('音频处理失败：录音尚未真正开始就已结束，请按住稍久一点后再松开');
      setIsRecording(false);
      setIsProcessing(false);
      return;
    }

    if (wavRecorderRef.current && isRecordingRef.current) {
      isRecordingRef.current = false;
      setIsRecording(false);
      isFinalizingRef.current = true;
      setIsProcessing(true);
      (async () => {
        const releaseActiveMicrophone = (reason) => {
          if (!streamRef.current) {
            return;
          }
          releaseMicrophoneStream(streamRef.current, reason);
          streamRef.current = null;
        };
        try {
          const stopAt = Date.now();
          const recorder = wavRecorderRef.current;
          wavRecorderRef.current = null;
          const realtimeSession = realtimeSessionRef.current;
          const realtimeStartPromise = realtimeStartPromiseRef.current;
          const realtimeStartError = realtimeStartErrorRef.current;
          const computedFinalTimeoutMs = computeRealtimeASRFinalTimeoutMs(
            recordStartAtRef.current ? stopAt - recordStartAtRef.current : 0
          );
          let realtimeFinalTimeoutMs = Math.min(computedFinalTimeoutMs, 5000);
          const recorderStopPromise = recorder.stop();
          const realtimeFinalPromise = (async () => {
            if (realtimeStartPromise) {
              await withTimeout(
                realtimeStartPromise,
                REALTIME_STOP_CONNECT_GRACE_MS,
                `Realtime ASR was not ready within ${REALTIME_STOP_CONNECT_GRACE_MS}ms after stop`
              );
            }
            if (!realtimeSession) {
              if (realtimeStartPromise) {
                throw realtimeStartErrorRef.current
                  || realtimeStartError
                  || new Error('Realtime ASR was started but no active session found');
              }
              return null;
            }
            if (!realtimeSession.hasSentAudio?.()) {
              realtimeSession.cancel();
              throw new Error('实时语音识别失败：没有向 18011 发送 PCM 音频');
            }
            if (realtimeSession.isAudioPumpStalled?.()) {
              throw new Error('实时语音识别失败：发送到 18011 的 PCM 音频流已停滞');
            }
            const hasPartialText = Boolean(realtimeSession.getLatestTextPayload?.());
            realtimeFinalTimeoutMs = hasPartialText
              ? computedFinalTimeoutMs
              : Math.min(computedFinalTimeoutMs, 5000);
            return realtimeSession.finish({ timeoutMs: realtimeFinalTimeoutMs });
          })();
          realtimeFinalPromise.catch(() => {});

          const { audioBlob, stats } = await recorderStopPromise;
          releaseActiveMicrophone('recording_stopped');
          let realtimePayload = null;
          let realtimeFailed = false;
          let realtimeFailedError = null;
          try {
            realtimePayload = await realtimeFinalPromise;
            if (realtimePayload?.success === false) {
              const reason = realtimePayload?.error || realtimePayload?.message || 'success=false';
              realtimeFailed = true;
              realtimeFailedError = new Error(reason);
              realtimePayload = null;
              logRecordingDebug('warn', 'Realtime ASR returned failure', {
                error: reason,
              });
            }
          } catch (error) {
            const partialFallback = selectRealtimeFinalTimeoutFallback(
              error,
              realtimeSession?.getLatestTextPayload?.()
            );
            if (partialFallback) {
              realtimePayload = partialFallback;
              logRecordingDebug('warn', 'Realtime ASR final timed out; latest partial selected', {
                textLength: String(partialFallback.text || partialFallback.partial_text || '').trim().length,
                finalTimeoutMs: realtimeFinalTimeoutMs,
              });
            } else {
              realtimeFailed = true;
              realtimeFailedError = error || new Error('Realtime ASR final failed');
              logRecordingDebug('warn', 'Realtime ASR final failed', {
                error: error?.message || String(error),
                finalTimeoutMs: realtimeFinalTimeoutMs,
              });
            }
            realtimeSession?.cancel();
          } finally {
            if (realtimeSessionRef.current === realtimeSession) {
              realtimeSessionRef.current = null;
            }
            if (realtimeStartPromiseRef.current === realtimeStartPromise) {
              realtimeStartPromiseRef.current = null;
            }
            realtimeStartErrorRef.current = null;
          }

          const localAudioStats = {
            ...stats,
          };

          logRecordingDebug('info', 'Recording stopped and WAV finalized', {
            sessionId: recordingSessionRef.current,
            holdMs: recordStartAtRef.current ? (stopAt - recordStartAtRef.current) : null,
            wavSize: audioBlob.size,
            blobType: audioBlob.type || 'unknown',
            wavDurationMs: localAudioStats?.durationMs,
            chunkCount: localAudioStats?.chunkCount,
            dataEventCount: localAudioStats?.dataEventCount,
            totalSamples: localAudioStats?.totalSamples,
            bufferSize: localAudioStats?.bufferSize,
            peakAbs: localAudioStats?.peakAbs,
            rms: localAudioStats?.rms,
            activeRatio: localAudioStats?.activeRatio,
            ...captureDiagnosticsRef.current,
          });

          if (realtimeFailed) {
            logRecordingDebug('warn', 'Realtime ASR failed before final text', {
              error: realtimeFailedError?.message || String(realtimeFailedError || ''),
            });
            throw realtimeFailedError || new Error('实时语音识别失败');
          }
          await processAudio(audioBlob, localAudioStats, realtimePayload);
        } finally {
          releaseActiveMicrophone('recording_finalization_cleanup');
          isFinalizingRef.current = false;
        }
      })().catch((err) => {
        logRecordingDebug('error', 'Recording finalization failed', {
          error: err?.message || String(err),
          sessionId: recordingSessionRef.current,
        });
        setError(`音频处理失败：${err.message}`);
        setIsProcessing(false);
      });
    }
  }, [abortPendingStart, logRecordingDebug, processAudio, releaseMicrophoneStream]);

  const cancelRecording = useCallback(() => {
    abortPendingStart('cancel');
    if (realtimeSessionRef.current) {
      realtimeSessionRef.current.cancel();
      realtimeSessionRef.current = null;
    }
    realtimeStartPromiseRef.current = null;
    if (wavRecorderRef.current) {
      wavRecorderRef.current.stop();
      wavRecorderRef.current = null;
    }

    if (streamRef.current) {
      releaseMicrophoneStream(streamRef.current, 'recording_canceled');
      streamRef.current = null;
    }

    captureDiagnosticsRef.current = null;
    isRecordingRef.current = false;
    setIsRecording(false);
    setIsProcessing(false);
    setError(null);
  }, [abortPendingStart, releaseMicrophoneStream]);

  useEffect(() => () => {
    stopMediaStream(streamRef.current);
    streamRef.current = null;
  }, [stopMediaStream]);

  const checkPermissions = useCallback(async () => {
    try {
      const result = await navigator.permissions.query({ name: 'microphone' });
      return result.state;
    } catch {
      return 'unknown';
    }
  }, []);

  return {
    isRecording,
    isProcessing,
    isOptimizing,
    error,
    audioData,
    startRecording,
    stopRecording,
    cancelRecording,
    checkPermissions,
  };
};
