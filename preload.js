const { contextBridge, ipcRenderer } = require("electron");

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld("electronAPI", {
  rendererHeartbeat: () => ipcRenderer.send("renderer-heartbeat"),
  // 窗口控制
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  hideFloatingBall: () => ipcRenderer.invoke("hide-floating-ball"),
  resizeFloatingBall: (width, height) => ipcRenderer.invoke("resize-floating-ball", width, height),
  showWindow: () => ipcRenderer.invoke("show-window"),
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  closeWindow: () => ipcRenderer.invoke("close-window"),
  moveWindow: (x, y) => ipcRenderer.invoke("move-window", x, y),

  // 录音相关
  startRecording: () => ipcRenderer.invoke("start-recording"),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  onToggleDictation: (callback) => {
    ipcRenderer.on("toggle-dictation", callback);
    return () => ipcRenderer.removeListener("toggle-dictation", callback);
  },

  // AI文本处理
  processText: (text, mode) => ipcRenderer.invoke("process-text", text, mode),
  checkAIStatus: (testConfig) => ipcRenderer.invoke("check-ai-status", testConfig),

  // 剪贴板操作
  pasteText: (text) => ipcRenderer.invoke("paste-text", text),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  setClipboardWatchEnabled: (enabled) => ipcRenderer.invoke("set-clipboard-watch-enabled", enabled),
  getClipboardWatchEnabled: () => ipcRenderer.invoke("get-clipboard-watch-enabled"),
  onClipboardTextChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("clipboard-text-changed", listener);
    return () => ipcRenderer.removeListener("clipboard-text-changed", listener);
  },

  // 数据库操作
  saveTranscription: (text, processedText) =>
    ipcRenderer.invoke("save-transcription", text, processedText),
  recordVoiceDatasetSample: (sample) =>
    ipcRenderer.invoke("record-voice-dataset-sample", sample),
  getTranscriptions: (limit, offset) =>
    ipcRenderer.invoke("get-transcriptions", limit, offset),
  deleteTranscription: (id) =>
    ipcRenderer.invoke("delete-transcription", id),
  clearAllTranscriptions: () =>
    ipcRenderer.invoke("clear-all-transcriptions"),

  // 翻译剪贴板历史操作
  saveTranslatedClipboard: (originalText, translatedText) =>
    ipcRenderer.invoke("save-translated-clipboard", originalText, translatedText),
  getTranslatedClipboardHistory: (limit, offset) =>
    ipcRenderer.invoke("get-translated-clipboard-history", limit, offset),
  deleteTranslatedClipboardItem: (id) =>
    ipcRenderer.invoke("delete-translated-clipboard-item", id),
  clearTranslatedClipboardHistory: () =>
    ipcRenderer.invoke("clear-translated-clipboard-history"),

  // 设置管理
  getSettings: () => ipcRenderer.invoke("get-settings"),
  getAllSettings: () => ipcRenderer.invoke("get-all-settings"),
  getSetting: (key, defaultValue) => ipcRenderer.invoke("get-setting", key, defaultValue),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value),
  saveSetting: (key, value) => ipcRenderer.invoke("save-setting", key, value),
  resetSettings: () => ipcRenderer.invoke("reset-settings"),

  // 实时 ASR 服务端配置；列表响应不包含令牌明文。
  listAsrConnectionProfiles: () => ipcRenderer.invoke("list-asr-connection-profiles"),
  saveAsrConnectionProfile: (profile, options) =>
    ipcRenderer.invoke("save-asr-connection-profile", profile, options),
  deleteAsrConnectionProfile: (profileId) =>
    ipcRenderer.invoke("delete-asr-connection-profile", profileId),
  activateAsrConnectionProfile: (profileId) =>
    ipcRenderer.invoke("activate-asr-connection-profile", profileId),
  getActiveAsrConnection: () => ipcRenderer.invoke("get-active-asr-connection"),
  resolveAsrConnectionProfile: (profile, options) =>
    ipcRenderer.invoke("resolve-asr-connection-profile", profile, options),

  // 热键管理
  registerHotkey: (hotkey) => ipcRenderer.invoke("register-hotkey", hotkey),
  unregisterHotkey: (hotkey) => ipcRenderer.invoke("unregister-hotkey", hotkey),
  getCurrentHotkey: () => ipcRenderer.invoke("get-current-hotkey"),

  // F2热键管理
  registerF2Hotkey: () => ipcRenderer.invoke("register-f2-hotkey"),
  unregisterF2Hotkey: () => ipcRenderer.invoke("unregister-f2-hotkey"),
  setRecordingState: (isRecording) => ipcRenderer.invoke("set-recording-state", isRecording),
  getRecordingState: () => ipcRenderer.invoke("get-recording-state"),

  // F2双击事件监听
  onF2DoubleClick: (callback) => {
    ipcRenderer.on("f2-double-click", callback);
    return () => ipcRenderer.removeListener("f2-double-click", callback);
  },

  // 热键触发事件监听
  onHotkeyTriggered: (callback) => {
    ipcRenderer.on("hotkey-triggered", callback);
    return () => ipcRenderer.removeListener("hotkey-triggered", callback);
  },

  // 按住录音键事件监听
  onCapsLockDown: (callback) => {
    ipcRenderer.on("caps-lock-down", callback);
    return () => ipcRenderer.removeListener("caps-lock-down", callback);
  },

  onCapsLockUp: (callback) => {
    ipcRenderer.on("caps-lock-up", callback);
    return () => ipcRenderer.removeListener("caps-lock-up", callback);
  },

  onCodexHoldDown: (callback) => {
    ipcRenderer.on("codex-hold-down", callback);
    return () => ipcRenderer.removeListener("codex-hold-down", callback);
  },

  onCodexHoldUp: (callback) => {
    ipcRenderer.on("codex-hold-up", callback);
    return () => ipcRenderer.removeListener("codex-hold-up", callback);
  },

  onExternalRecordingStart: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("external-recording-start", listener);
    return () => ipcRenderer.removeListener("external-recording-start", listener);
  },

  onExternalRecordingChunk: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("external-recording-chunk", listener);
    return () => ipcRenderer.removeListener("external-recording-chunk", listener);
  },

  onExternalRecordingStop: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("external-recording-stop", listener);
    return () => ipcRenderer.removeListener("external-recording-stop", listener);
  },

  onExternalRecordingCancel: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("external-recording-cancel", listener);
    return () => ipcRenderer.removeListener("external-recording-cancel", listener);
  },

  onExternalRecordingError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("external-recording-error", listener);
    return () => ipcRenderer.removeListener("external-recording-error", listener);
  },

  reportExternalRecordingResult: (payload) =>
    ipcRenderer.invoke("m5-voice-recording-result", payload),

  interruptMiniCPMVoice: () => ipcRenderer.invoke("interrupt-minicpm-voice"),
  submitMiniCPMVoicePrompt: (prompt) => ipcRenderer.invoke("submit-minicpm-voice-prompt", prompt),
  submitCodexVoicePrompt: (prompt) => ipcRenderer.invoke("submit-codex-voice-prompt", prompt),
  submitCodexTerminalPrompt: (prompt) => ipcRenderer.invoke("submit-codex-terminal-prompt", prompt),
  getVoiceActionIntentManifest: () => ipcRenderer.invoke("get-voice-action-intent-manifest"),
  executeVoiceActionIntent: (payload) => ipcRenderer.invoke("execute-voice-action-intent", payload),
  cancelCodexVoiceRoute: (payload) => ipcRenderer.invoke("cancel-codex-voice-route", payload),
  learnVoiceRouteShortcut: (candidate) => ipcRenderer.invoke("learn-voice-route-shortcut", candidate),
  getLinkBookmarks: () => ipcRenderer.invoke("get-link-bookmarks"),
  saveLinkBookmark: (bookmark) => ipcRenderer.invoke("save-link-bookmark", bookmark),
  deleteLinkBookmark: (id) => ipcRenderer.invoke("delete-link-bookmark", id),
  reloadLinkBookmarks: () => ipcRenderer.invoke("reload-link-bookmarks"),
  openLinkBookmark: (payload) => ipcRenderer.invoke("open-link-bookmark", payload),
  openCodexDebugTerminal: () => ipcRenderer.invoke("open-codex-debug-terminal"),
  resolveNx1QwenRouter: (options) => ipcRenderer.invoke("resolve-nx1-qwen-router", options),
  testNx1QwenRouter: () => ipcRenderer.invoke("test-nx1-qwen-router"),
  submitNx1QwenChat: (messages, options) => ipcRenderer.invoke("submit-nx1-qwen-chat", messages, options),
  routeNx1QwenTerminalRequest: (payload) => ipcRenderer.invoke("route-nx1-qwen-terminal-request", payload),
  onCodexVoiceUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("codex-voice-update", listener);
    return () => ipcRenderer.removeListener("codex-voice-update", listener);
  },

  // 按住录音键短按阈值配置
  setCapsMinHoldMs: (ms) => ipcRenderer.invoke("set-caps-min-hold-ms", ms),
  getCapsMinHoldMs: () => ipcRenderer.invoke("get-caps-min-hold-ms"),
  setDictationKeyCaptureEnabled: (enabled) => ipcRenderer.invoke("set-dictation-key-capture-enabled", enabled),
  setFloatingBallInputCaptureEnabled: (enabled) => ipcRenderer.invoke("set-floating-ball-input-capture-enabled", enabled),
  onDictationCancelRequested: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("dictation-cancel-requested", listener);
    return () => ipcRenderer.removeListener("dictation-cancel-requested", listener);
  },
  onDictationConfirmRequested: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("dictation-confirm-requested", listener);
    return () => ipcRenderer.removeListener("dictation-confirm-requested", listener);
  },

  // 文件操作
  exportTranscriptions: (format) => ipcRenderer.invoke("export-transcriptions", format),
  importSettings: () => ipcRenderer.invoke("import-settings"),
  exportSettings: () => ipcRenderer.invoke("export-settings"),

  // 系统信息
  getSystemInfo: () => ipcRenderer.invoke("get-system-info"),
  checkPermissions: () => ipcRenderer.invoke("check-permissions"),
  requestPermissions: () => ipcRenderer.invoke("request-permissions"),
  testAccessibilityPermission: () => ipcRenderer.invoke("test-accessibility-permission"),
  openSystemPermissions: () => ipcRenderer.invoke("open-system-permissions"),

  // 应用信息
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),

  // 调试和日志
  log: (level, message, data = null) => ipcRenderer.invoke("log", level, message, data),
  getDebugInfo: () => ipcRenderer.invoke("get-debug-info"),

  // 事件监听
  onTranscriptionUpdate: (callback) => {
    ipcRenderer.on("transcription-update", callback);
    return () => ipcRenderer.removeListener("transcription-update", callback);
  },
  onProcessingUpdate: (callback) => {
    ipcRenderer.on("processing-update", callback);
    return () => ipcRenderer.removeListener("processing-update", callback);
  },
  onError: (callback) => {
    ipcRenderer.on("error", callback);
    return () => ipcRenderer.removeListener("error", callback);
  },
  onSettingsUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("settings-update", listener);
    return () => ipcRenderer.removeListener("settings-update", listener);
  },

  // 控制面板相关
  openControlPanel: () => ipcRenderer.invoke("open-control-panel"),
  closeControlPanel: () => ipcRenderer.invoke("close-control-panel"),

  // 历史记录窗口相关
  openHistoryWindow: () => ipcRenderer.invoke("open-history-window"),
  closeHistoryWindow: () => ipcRenderer.invoke("close-history-window"),
  hideHistoryWindow: () => ipcRenderer.invoke("hide-history-window"),
  openLinkDirectoryWindow: () => ipcRenderer.invoke("open-link-directory-window"),

  // 设置窗口相关
  openSettingsWindow: () => ipcRenderer.invoke("open-settings-window"),
  closeSettingsWindow: () => ipcRenderer.invoke("close-settings-window"),
  hideSettingsWindow: () => ipcRenderer.invoke("hide-settings-window"),
  openAsrAdminWindow: () => ipcRenderer.invoke("open-asr-admin-window"),

  // 中文特定功能
  detectLanguage: (text) => ipcRenderer.invoke("detect-language", text),
  segmentChinese: (text) => ipcRenderer.invoke("segment-chinese", text),
  addPunctuation: (text) => ipcRenderer.invoke("add-punctuation", text),

  // 音频处理
  convertAudioFormat: (audioData, targetFormat) =>
    ipcRenderer.invoke("convert-audio-format", audioData, targetFormat),
  enhanceAudio: (audioData) => ipcRenderer.invoke("enhance-audio", audioData),

  // 模型管理
  downloadModel: (modelName) => ipcRenderer.invoke("download-model", modelName),
  getAvailableModels: () => ipcRenderer.invoke("get-available-models"),
  getCurrentModel: () => ipcRenderer.invoke("get-current-model"),
  switchModel: (modelName) => ipcRenderer.invoke("switch-model", modelName),

  // 模型下载进度监听
  onModelDownloadProgress: (callback) => {
    ipcRenderer.on("model-download-progress", callback);
    return () => ipcRenderer.removeListener("model-download-progress", callback);
  },

  // 性能监控
  getPerformanceStats: () => ipcRenderer.invoke("get-performance-stats"),
  clearPerformanceStats: () => ipcRenderer.invoke("clear-performance-stats"),

  // 进程监控
  getMonitorConfigs: () => ipcRenderer.invoke("get-monitor-configs"),
  addMonitorConfig: (config) => ipcRenderer.invoke("add-monitor-config", config),
  updateMonitorConfig: (id, updates) => ipcRenderer.invoke("update-monitor-config", id, updates),
  deleteMonitorConfig: (id) => ipcRenderer.invoke("delete-monitor-config", id),
  startMonitor: (id) => ipcRenderer.invoke("start-monitor", id),
  stopMonitor: (id) => ipcRenderer.invoke("stop-monitor", id),
  getMonitorStatus: (id) => ipcRenderer.invoke("get-monitor-status", id),
  getAllMonitorsStatus: () => ipcRenderer.invoke("get-all-monitors-status"),
  isMonitorRunning: (id) => ipcRenderer.invoke("is-monitor-running", id),

  // 进程监控事件监听
  onMonitorStatusUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("monitor-status-update", listener);
    return () => ipcRenderer.removeListener("monitor-status-update", listener);
  },
  onMonitorAlert: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("monitor-alert", listener);
    return () => ipcRenderer.removeListener("monitor-alert", listener);
  },
  onMonitorError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("monitor-error", listener);
    return () => ipcRenderer.removeListener("monitor-error", listener);
  },
  onMonitorStopped: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("monitor-stopped", listener);
    return () => ipcRenderer.removeListener("monitor-stopped", listener);
  },
  onMonitorProcessExited: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("monitor-process-exited", listener);
    return () => ipcRenderer.removeListener("monitor-process-exited", listener);
  }
});

// 添加一些实用的常量
contextBridge.exposeInMainWorld("constants", {
  APP_NAME: "语音转写",
  VERSION: "1.0.0",
  SUPPORTED_AUDIO_FORMATS: ["wav", "mp3", "m4a", "flac"],
  SUPPORTED_EXPORT_FORMATS: ["txt", "docx", "pdf", "json"],
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  MAX_RECORDING_DURATION: 300000, // 5分钟
  MAX_TEXT_LENGTH: 10000,
  CHINESE_LANGUAGE_CODES: ["zh", "zh-CN", "zh-TW", "zh-HK"]
});

// 添加调试信息（仅在开发模式下）
if (process.env.NODE_ENV === "development") {
  contextBridge.exposeInMainWorld("debug", {
    getElectronVersion: () => process.versions.electron,
    getNodeVersion: () => process.versions.node,
    getChromeVersion: () => process.versions.chrome,
    getPlatform: () => process.platform,
    getArch: () => process.arch
  });
}
