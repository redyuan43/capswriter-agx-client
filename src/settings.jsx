import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { toast, Toaster } from "sonner";
import { Settings, X, Loader2, Play, Circle, History, Radio, Server, BookOpenCheck, Keyboard } from "lucide-react";
import { usePermissions } from "./hooks/usePermissions";
import { getBackendStatus, getTtsHealth } from "./services/backendAPI.js";

const TranslatedHistory = lazy(() => import("./components/TranslatedHistory"));
const M5BridgePanel = lazy(() => import("./components/M5BridgePanel"));
const AsrConnectionPanel = lazy(() => import("./components/AsrConnectionPanel"));
const KnobMapperPanel = lazy(() => import("./components/KnobMapperPanel"));

const SETTING_VOICE_TRANSLATE_MODE = "voice_translate_mode";
const SETTING_VOICE_TRANSLATE_TARGET = "voice_translate_target";
const SETTING_VOICE_TTS_ENABLED = "voice_tts_enabled";
const SETTING_VOICE_TTS_SPEED = "voice_tts_speed";
const SETTING_VOICE_TTS_SPEAKER = "voice_tts_speaker";
const SETTING_VOICE_TTS_INSTRUCTION = "voice_tts_instruction";
const SETTING_VOICE_RELEASE_GRACE_MS = "voice_release_grace_ms";
const DEFAULT_VOICE_RELEASE_GRACE_MS = 300;
const SETTING_CAPS_MIN_HOLD_MS = "caps_min_hold_ms";
const DEFAULT_CAPS_MIN_HOLD_MS = 150;
const DEFAULT_TTS_SPEED = 1.0;
const DEFAULT_TTS_SPEAKER = "Vivian";
const DEFAULT_TTS_INSTRUCTION = "";
const VOICE_TRANSLATE_NONE = "none";
const VOICE_TRANSLATE_EN = "en";
const VOICE_TRANSLATE_ZH = "zh";

function initialSettingsTab() {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return ["bridge", "asr", "knob"].includes(tab) ? tab : "settings";
}

function PanelLoading() {
  return <div className="flex flex-1 items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-blue-600" /></div>;
}

const SettingsPage = () => {
  const [loading, setLoading] = useState(true);
  const [voiceTranslateTarget, setVoiceTranslateTarget] = useState(VOICE_TRANSLATE_NONE);
  const [voiceTtsEnabled, setVoiceTtsEnabled] = useState(false);
  const [voiceTtsSpeed, setVoiceTtsSpeed] = useState(DEFAULT_TTS_SPEED);
  const [voiceTtsSpeaker, setVoiceTtsSpeaker] = useState(DEFAULT_TTS_SPEAKER);
  const [voiceTtsInstruction, setVoiceTtsInstruction] = useState(DEFAULT_TTS_INSTRUCTION);
  const [availableTtsSpeakers, setAvailableTtsSpeakers] = useState([DEFAULT_TTS_SPEAKER]);
  const [ttsSupportsInstruction, setTtsSupportsInstruction] = useState(false);
  const [voiceReleaseGraceMs, setVoiceReleaseGraceMs] = useState(DEFAULT_VOICE_RELEASE_GRACE_MS);
  const [capsMinHoldMs, setCapsMinHoldMs] = useState(DEFAULT_CAPS_MIN_HOLD_MS);
  const [savingVoiceSettings, setSavingVoiceSettings] = useState(false);
  const [activeTab, setActiveTab] = useState(initialSettingsTab);
  const [appVersion, setAppVersion] = useState('');

  const showAlert = (alert) => {
    toast(alert.title, {
      description: alert.description,
      duration: 4000,
    });
  };

  const {
    micPermissionGranted,
    accessibilityPermissionGranted,
    requestMicPermission,
    testAccessibilityPermission,
  } = usePermissions(showAlert);

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

  const resolveTtsSpeakerState = useCallback((savedSpeaker, backendStatus) => {
    const requestedSpeaker = String(savedSpeaker || "").trim();
    const runtimeSpeakers = Array.isArray(backendStatus?.tts_supported_speakers)
      ? backendStatus.tts_supported_speakers.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const backendDefaultSpeaker = String(
      backendStatus?.tts_default_speaker || DEFAULT_TTS_SPEAKER
    ).trim() || DEFAULT_TTS_SPEAKER;

    if (!runtimeSpeakers.length) {
      const resolvedSpeaker = requestedSpeaker || backendDefaultSpeaker;
      return {
        resolvedSpeaker,
        speakerOptions: Array.from(new Set([backendDefaultSpeaker, resolvedSpeaker].filter(Boolean))),
        shouldPersistResolvedSpeaker: false,
      };
    }

    const requestedMatch = requestedSpeaker
      ? runtimeSpeakers.find((item) => item.toLowerCase() === requestedSpeaker.toLowerCase())
      : null;
    const defaultMatch = runtimeSpeakers.find(
      (item) => item.toLowerCase() === backendDefaultSpeaker.toLowerCase()
    );
    const resolvedSpeaker = requestedMatch || defaultMatch || runtimeSpeakers[0];

    return {
      resolvedSpeaker,
      speakerOptions: Array.from(new Set([resolvedSpeaker, ...runtimeSpeakers])),
      shouldPersistResolvedSpeaker: Boolean(requestedSpeaker) && resolvedSpeaker !== requestedSpeaker,
    };
  }, []);

  const refreshTtsCapabilities = useCallback(async (savedSpeaker) => {
    const [ttsHealth, backendStatus] = await Promise.allSettled([
      getTtsHealth(),
      getBackendStatus(),
    ]);
    const ttsStatus = ttsHealth.status === "fulfilled"
      ? ttsHealth.value
      : backendStatus.status === "fulfilled"
        ? backendStatus.value
        : null;
    if (!ttsStatus) return;

    const { speakerOptions } = resolveTtsSpeakerState(savedSpeaker, ttsStatus);
    setAvailableTtsSpeakers(speakerOptions.length ? speakerOptions : [DEFAULT_TTS_SPEAKER]);
    setTtsSupportsInstruction(Boolean(ttsStatus.tts_supports_instruction));
  }, [resolveTtsSpeakerState]);

  const loadVoiceSettings = useCallback(async () => {
    if (!window.electronAPI?.getSetting) {
      setLoading(false);
      return;
    }

    try {
      const [mode, target, ttsEnabled, ttsSpeed, ttsSpeaker, ttsInstruction, releaseGraceMs, savedCapsMinHoldMs] = await Promise.all([
        window.electronAPI.getSetting(SETTING_VOICE_TRANSLATE_MODE, "transcribe"),
        window.electronAPI.getSetting(SETTING_VOICE_TRANSLATE_TARGET, "zh"),
        window.electronAPI.getSetting(SETTING_VOICE_TTS_ENABLED, false),
        window.electronAPI.getSetting(SETTING_VOICE_TTS_SPEED, DEFAULT_TTS_SPEED),
        window.electronAPI.getSetting(SETTING_VOICE_TTS_SPEAKER, ""),
        window.electronAPI.getSetting(SETTING_VOICE_TTS_INSTRUCTION, DEFAULT_TTS_INSTRUCTION),
        window.electronAPI.getSetting(SETTING_VOICE_RELEASE_GRACE_MS, DEFAULT_VOICE_RELEASE_GRACE_MS),
        window.electronAPI.getSetting(SETTING_CAPS_MIN_HOLD_MS, DEFAULT_CAPS_MIN_HOLD_MS),
      ]);
      const nextTarget =
        mode === "translate" && (target === VOICE_TRANSLATE_EN || target === VOICE_TRANSLATE_ZH)
          ? target
          : VOICE_TRANSLATE_NONE;
      setVoiceTranslateTarget(nextTarget);
      setVoiceTtsEnabled(!!ttsEnabled);
      setVoiceTtsSpeed(normalizeTtsSpeed(ttsSpeed));
      const nextSpeaker = String(ttsSpeaker || "").trim();
      const {
        resolvedSpeaker,
        speakerOptions,
      } = resolveTtsSpeakerState(nextSpeaker, null);
      setVoiceTtsSpeaker(resolvedSpeaker);
      setVoiceTtsInstruction(String(ttsInstruction || DEFAULT_TTS_INSTRUCTION).trim());
      setAvailableTtsSpeakers(speakerOptions.length ? speakerOptions : [DEFAULT_TTS_SPEAKER]);
      setTtsSupportsInstruction(false);
      setVoiceReleaseGraceMs(normalizeReleaseGraceMs(releaseGraceMs));
      setCapsMinHoldMs(
        Number.isFinite(Number(savedCapsMinHoldMs))
          ? Math.max(0, Number(savedCapsMinHoldMs))
          : DEFAULT_CAPS_MIN_HOLD_MS
      );
      refreshTtsCapabilities(nextSpeaker).catch(() => {});
    } catch (error) {
      toast.error("加载语音设置失败", {
        description: error?.message || String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [normalizeReleaseGraceMs, normalizeTtsSpeed, refreshTtsCapabilities, resolveTtsSpeakerState]);

  useEffect(() => {
    loadVoiceSettings();
  }, [loadVoiceSettings]);

  useEffect(() => {
    window.electronAPI?.getAppVersion?.()
      .then((version) => setAppVersion(String(version || '').trim()))
      .catch(() => setAppVersion(''));
  }, []);

  const handleActivateFloatingBall = async () => {
    if (window.electronAPI) {
      try {
        await window.electronAPI.showWindow();
        toast.success("悬浮球已激活");
      } catch (error) {
        toast.error("激活失败: " + error.message);
      }
    }
  };

  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.hideSettingsWindow();
    }
  };

  const handleOpenAsrAdmin = async () => {
    if (!window.electronAPI?.openAsrAdminWindow) return;

    try {
      await window.electronAPI.openAsrAdminWindow();
    } catch (error) {
      toast.error("ASR 管理后台打开失败", {
        description: error?.message || String(error),
      });
    }
  };

  const handleToggleTranslateTarget = async (target) => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;
    if (target !== VOICE_TRANSLATE_EN && target !== VOICE_TRANSLATE_ZH) return;

    const current = voiceTranslateTarget;
    const next = current === target ? VOICE_TRANSLATE_NONE : target;
    setVoiceTranslateTarget(next);
    setSavingVoiceSettings(true);

    try {
      if (next !== VOICE_TRANSLATE_NONE) {
        await window.electronAPI.setSetting(SETTING_VOICE_TRANSLATE_TARGET, next);
      }
      await window.electronAPI.setSetting(
        SETTING_VOICE_TRANSLATE_MODE,
        next === VOICE_TRANSLATE_NONE ? "transcribe" : "translate"
      );
      if (next === VOICE_TRANSLATE_EN) {
        toast.success("翻译为英文已开启");
      } else if (next === VOICE_TRANSLATE_ZH) {
        toast.success("翻译为中文已开启");
      } else if (current === VOICE_TRANSLATE_EN) {
        toast.success("翻译为英文已关闭");
      } else if (current === VOICE_TRANSLATE_ZH) {
        toast.success("翻译为中文已关闭");
      } else {
        toast.success("翻译模式已关闭");
      }
    } catch (error) {
      setVoiceTranslateTarget(current);
      toast.error("更新翻译设置失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  const handleToggleVoiceTts = async () => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;

    const next = !voiceTtsEnabled;
    setVoiceTtsEnabled(next);
    setSavingVoiceSettings(true);

    try {
      await window.electronAPI.setSetting(SETTING_VOICE_TTS_ENABLED, next);
      toast.success(next ? "语音播报已开启" : "语音播报已关闭");
      if (next) {
        window.setTimeout(() => {
          loadVoiceSettings().catch(() => { });
        }, 1500);
      }
    } catch (error) {
      setVoiceTtsEnabled(!next);
      toast.error("更新语音播报失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  const handleSaveTtsSpeed = async () => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;
    const next = normalizeTtsSpeed(voiceTtsSpeed);
    setVoiceTtsSpeed(next);
    setSavingVoiceSettings(true);
    try {
      await window.electronAPI.setSetting(SETTING_VOICE_TTS_SPEED, next);
      toast.success(`语速已更新为 ${next}x`);
    } catch (error) {
      toast.error("更新语速失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  const handleSaveTtsSpeaker = async (value) => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;
    const next = String(value || DEFAULT_TTS_SPEAKER).trim() || DEFAULT_TTS_SPEAKER;
    setVoiceTtsSpeaker(next);
    setSavingVoiceSettings(true);
    try {
      await window.electronAPI.setSetting(SETTING_VOICE_TTS_SPEAKER, next);
      toast.success(`音色已切换为 ${next}`);
    } catch (error) {
      toast.error("更新音色失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  const handleSaveTtsInstruction = async () => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;
    const next = String(voiceTtsInstruction || "").trim();
    setVoiceTtsInstruction(next);
    setSavingVoiceSettings(true);
    try {
      await window.electronAPI.setSetting(SETTING_VOICE_TTS_INSTRUCTION, next);
      toast.success(next ? "播报指令已保存" : "播报指令已清空");
    } catch (error) {
      toast.error("更新播报指令失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  const handleVoiceReleaseGraceChange = (event) => {
    setVoiceReleaseGraceMs(normalizeReleaseGraceMs(event.target.value));
  };

  const handleSaveVoiceReleaseGrace = async () => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;
    const next = normalizeReleaseGraceMs(voiceReleaseGraceMs);
    setVoiceReleaseGraceMs(next);
    setSavingVoiceSettings(true);
    try {
      await window.electronAPI.setSetting(SETTING_VOICE_RELEASE_GRACE_MS, next);
      toast.success(`尾音缓冲已更新为 ${next}ms`);
    } catch (error) {
      toast.error("更新尾音缓冲失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  const handleSaveCapsMinHoldMs = async () => {
    if (!window.electronAPI?.setSetting || savingVoiceSettings) return;
    const next = Math.max(
      0,
      Number.isFinite(Number(capsMinHoldMs)) ? Number(capsMinHoldMs) : DEFAULT_CAPS_MIN_HOLD_MS
    );
    setCapsMinHoldMs(next);
    setSavingVoiceSettings(true);
    try {
      await window.electronAPI.setSetting(SETTING_CAPS_MIN_HOLD_MS, next);
      window.electronAPI?.setCapsMinHoldMs?.(next);
      toast.success(`短按阈值已更新为 ${next}ms`);
    } catch (error) {
      toast.error("更新短按阈值失败", {
        description: error?.message || String(error),
      });
    } finally {
      setSavingVoiceSettings(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center text-gray-900">
        <div className="flex items-center space-x-3">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="text-gray-700">加载中...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-white text-gray-900 flex flex-col">
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Settings className="w-5 h-5 text-blue-600" />
            <h1 className="text-lg font-bold text-gray-900 chinese-title">设置</h1>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setActiveTab(activeTab === 'bridge' ? 'settings' : 'bridge')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 rounded-lg transition-colors ${activeTab === 'bridge' ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <Radio className="w-4 h-4" />
              M5 Bridge
            </button>
            <button
              onClick={() => setActiveTab('asr')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 rounded-lg transition-colors ${activeTab === 'asr' ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <Server className="w-4 h-4" />
              ASR 服务端
            </button>
            <button
              onClick={() => setActiveTab('knob')}
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 rounded-lg transition-colors ${activeTab === 'knob' ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'}`}
            >
              <Keyboard className="w-4 h-4" />
              设备映射
            </button>
            <button
              onClick={handleOpenAsrAdmin}
              className="px-3 py-1.5 text-sm flex items-center gap-1.5 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <BookOpenCheck className="w-4 h-4" />
              ASR 管理
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className="px-3 py-1.5 text-sm flex items-center gap-1.5 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <History className="w-4 h-4" />
              翻译历史
            </button>
            <button
              onClick={handleClose}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'history' && (
        <Suspense fallback={<PanelLoading />}>
          <TranslatedHistory onClose={() => setActiveTab('settings')} />
        </Suspense>
      )}

      {activeTab === 'bridge' && <Suspense fallback={<PanelLoading />}><M5BridgePanel /></Suspense>}

      {activeTab === 'asr' && <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-md mx-auto p-4 pb-6">
          <Suspense fallback={<PanelLoading />}><AsrConnectionPanel /></Suspense>
        </div>
      </div>}

      {activeTab === 'knob' && (
        <Suspense fallback={<PanelLoading />}>
          <KnobMapperPanel />
        </Suspense>
      )}

      {activeTab === 'settings' && <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-md mx-auto p-6 pb-8">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6">
            <div className="p-6">
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-gray-900 chinese-title mb-2">
                  激活悬浮球
                </h2>
                <p className="text-sm text-gray-600">
                  点击下方按钮激活悬浮球，或按住 Right Shift 键开始录音。
                </p>
              </div>

              <button
                onClick={handleActivateFloatingBall}
                className="w-full py-4 px-6 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium text-lg transition-colors duration-200 flex items-center justify-center space-x-3 shadow-sm"
              >
                <Play className="w-6 h-6" />
                <span>激活悬浮球</span>
              </button>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 chinese-title">
                  语音模式
                </h2>
                <p className="text-xs text-gray-600 mt-1">
                  控制识别后的翻译与播报行为。
                </p>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => handleToggleTranslateTarget(VOICE_TRANSLATE_EN)}
                  disabled={savingVoiceSettings}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 rounded-lg text-left hover:bg-gray-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <div>
                    <div className="text-sm text-gray-900">翻译为英文</div>
                    <div className="text-xs text-gray-600 mt-1">
                      开启后按英文翻译模式处理识别文本
                    </div>
                  </div>
                  <span className="flex items-center gap-2">
                    <span className={`text-xs ${voiceTranslateTarget === VOICE_TRANSLATE_EN ? "text-green-600" : "text-gray-500"}`}>
                      {voiceTranslateTarget === VOICE_TRANSLATE_EN ? "ON" : "OFF"}
                    </span>
                    <span
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${voiceTranslateTarget === VOICE_TRANSLATE_EN ? "bg-green-500" : "bg-gray-300"
                        }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${voiceTranslateTarget === VOICE_TRANSLATE_EN ? "translate-x-5" : "translate-x-1"
                          }`}
                      />
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handleToggleTranslateTarget(VOICE_TRANSLATE_ZH)}
                  disabled={savingVoiceSettings}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 rounded-lg text-left hover:bg-gray-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <div>
                    <div className="text-sm text-gray-900">翻译为中文</div>
                    <div className="text-xs text-gray-600 mt-1">
                      开启后按中文翻译模式处理识别文本
                    </div>
                  </div>
                  <span className="flex items-center gap-2">
                    <span className={`text-xs ${voiceTranslateTarget === VOICE_TRANSLATE_ZH ? "text-green-600" : "text-gray-500"}`}>
                      {voiceTranslateTarget === VOICE_TRANSLATE_ZH ? "ON" : "OFF"}
                    </span>
                    <span
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${voiceTranslateTarget === VOICE_TRANSLATE_ZH ? "bg-green-500" : "bg-gray-300"
                        }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${voiceTranslateTarget === VOICE_TRANSLATE_ZH ? "translate-x-5" : "translate-x-1"
                          }`}
                      />
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleVoiceTts}
                  disabled={savingVoiceSettings}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 rounded-lg text-left hover:bg-gray-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <div>
                    <div className="text-sm text-gray-900">语音播报</div>
                    <div className="text-xs text-gray-600 mt-1">
                      开启后持续触发播报（非一次性）
                    </div>
                  </div>
                  <span className="flex items-center gap-2">
                    <span className={`text-xs ${voiceTtsEnabled ? "text-green-600" : "text-gray-500"}`}>
                      {voiceTtsEnabled ? "ON" : "OFF"}
                    </span>
                    <span
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${voiceTtsEnabled ? "bg-green-500" : "bg-gray-300"
                        }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${voiceTtsEnabled ? "translate-x-5" : "translate-x-1"
                          }`}
                      />
                    </span>
                  </span>
                </button>

                <div className="w-full p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm text-gray-900">语速</div>
                      <div className="text-xs text-gray-600 mt-1">
                        作用于实时播报和手动触发的 TTS 请求
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min="0.5"
                        max="2"
                        step="0.1"
                        value={voiceTtsSpeed}
                        onChange={(e) => setVoiceTtsSpeed(normalizeTtsSpeed(e.target.value))}
                        disabled={savingVoiceSettings}
                        className="w-28"
                      />
                      <input
                        type="number"
                        min="0.5"
                        max="2"
                        step="0.1"
                        value={voiceTtsSpeed}
                        onChange={(e) => setVoiceTtsSpeed(normalizeTtsSpeed(e.target.value))}
                        disabled={savingVoiceSettings}
                        className="w-20 px-2 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-900"
                      />
                      <span className="text-xs text-gray-500">x</span>
                      <button
                        type="button"
                        onClick={handleSaveTtsSpeed}
                        disabled={savingVoiceSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                </div>

                <div className="w-full p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm text-gray-900">音色</div>
                      <div className="text-xs text-gray-600 mt-1">
                        使用运行时返回的可用音色列表；未加载模型时回退为默认音色
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={voiceTtsSpeaker}
                        onChange={(e) => handleSaveTtsSpeaker(e.target.value)}
                        disabled={savingVoiceSettings}
                        className="min-w-36 px-2 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-900"
                      >
                        {availableTtsSpeakers.map((speaker) => (
                          <option key={speaker} value={speaker}>
                            {speaker}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="w-full p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm text-gray-900">播报指令</div>
                      <div className="text-xs text-gray-600 mt-1">
                        {ttsSupportsInstruction ? "当前模型支持风格/语气指令" : "当前模型可能不支持指令控制，服务端会自动忽略该字段"}
                      </div>
                    </div>
                  </div>
                  <textarea
                    value={voiceTtsInstruction}
                    onChange={(e) => setVoiceTtsInstruction(e.target.value)}
                    disabled={savingVoiceSettings}
                    rows={3}
                    placeholder="例如：请用更快的语速，自然清晰地播报。"
                    className="mt-3 w-full px-3 py-2 text-sm rounded-md border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400"
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setVoiceTtsInstruction("请用更快的语速，自然清晰地播报。")}
                        disabled={savingVoiceSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-60"
                      >
                        更快
                      </button>
                      <button
                        type="button"
                        onClick={() => setVoiceTtsInstruction("请用更慢的语速，停顿更自然一些。")}
                        disabled={savingVoiceSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-60"
                      >
                        更慢
                      </button>
                      <button
                        type="button"
                        onClick={() => setVoiceTtsInstruction("请像新闻播报一样稳定、清晰地朗读。")}
                        disabled={savingVoiceSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-60"
                      >
                        新闻风格
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleSaveTtsInstruction}
                      disabled={savingVoiceSettings}
                      className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      保存
                    </button>
                  </div>
                </div>

                <div className="w-full p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm text-gray-900">松键尾音缓冲</div>
                      <div className="text-xs text-gray-600 mt-1">
                        Right Shift 松开后继续录音一小段时间，减少尾音被截断
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="1000"
                        step="50"
                        value={voiceReleaseGraceMs}
                        onChange={handleVoiceReleaseGraceChange}
                        disabled={savingVoiceSettings}
                        className="w-24 px-2 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-900"
                      />
                      <span className="text-xs text-gray-500">ms</span>
                      <button
                        type="button"
                        onClick={handleSaveVoiceReleaseGrace}
                        disabled={savingVoiceSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                </div>

                <div className="w-full p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm text-gray-900">短按忽略阈值</div>
                      <div className="text-xs text-gray-600 mt-1">
                        按下 Right Shift 不足此时间视为短按，不触发录音（设为 0 则禁用过滤）
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="2000"
                        step="50"
                        value={capsMinHoldMs}
                        onChange={(e) => setCapsMinHoldMs(e.target.value)}
                        disabled={savingVoiceSettings}
                        className="w-24 px-2 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-900"
                      />
                      <span className="text-xs text-gray-500">ms</span>
                      <button
                        type="button"
                        onClick={handleSaveCapsMinHoldMs}
                        disabled={savingVoiceSettings}
                        className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 chinese-title">
                  权限状态
                </h2>
                <p className="text-xs text-gray-600 mt-1">
                  确保以下权限已授权。
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <Circle className={`w-3 h-3 ${micPermissionGranted ? 'fill-green-500 text-green-500' : 'fill-red-500 text-red-500'}`} />
                    <span className="text-sm text-gray-700">麦克风权限</span>
                  </div>
                  <button
                    onClick={requestMicPermission}
                    className="text-xs px-3 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition-colors"
                  >
                    测试
                  </button>
                </div>

                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <Circle className={`w-3 h-3 ${accessibilityPermissionGranted ? 'fill-green-500 text-green-500' : 'fill-red-500 text-red-500'}`} />
                    <span className="text-sm text-gray-700">辅助功能权限</span>
                  </div>
                  <button
                    onClick={testAccessibilityPermission}
                    className="text-xs px-3 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition-colors"
                  >
                    测试
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500">
              按住 Right Shift 键开始录音，松开结束录音
            </p>
            {appVersion && (
              <p className="mt-2 text-xs text-gray-400">
                CapsWriter AGX Client v{appVersion}
              </p>
            )}
          </div>
        </div>
      </div>}

      <Toaster position="top-center" />
    </div>
  );
};

export { SettingsPage };

const settingsRoot = document.getElementById("settings-root");
if (settingsRoot) {
  createRoot(settingsRoot).render(<SettingsPage />);
}
