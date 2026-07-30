const {
  app,
  globalShortcut,
  BrowserWindow,
  ipcMain,
  dialog,
  Notification,
  shell,
  session,
  systemPreferences,
  crashReporter
} = require("electron");
const path = require("path");
const { spawn, execSync } = require("child_process");

// Codex completion chimes are owned by the renderer UI. The event is triggered
// by global hold-key/task IPC rather than a DOM click, so allow that app audio.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const ASR_PROXY_BYPASS_RULES = (process.env.CAPSWRITER_ASR_PROXY_BYPASS_LIST
  || '<local>,asr.yuanspaces.com,*.taild500c8.ts.net,100.64.0.0/10')
  .replaceAll(';', ',');
const ASR_PROXY_SERVER = normalizeProxyServer(
  process.env.CAPSWRITER_ASR_PROXY_SERVER
  || process.env.HTTPS_PROXY
  || process.env.https_proxy,
);
const ASR_PROXY_CONFIG_TIMEOUT_MS = 3000;

function normalizeProxyServer(value) {
  try {
    const proxy = new URL(String(value || '').trim());
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname) {
      return '';
    }
    return `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ''}`;
  } catch {
    return '';
  }
}

function buildSessionProxyConfig() {
  if (ASR_PROXY_SERVER) {
    return {
      mode: 'fixed_servers',
      proxyRules: ASR_PROXY_SERVER,
      proxyBypassRules: ASR_PROXY_BYPASS_RULES,
    };
  }
  return {
    mode: 'system',
    proxyBypassRules: ASR_PROXY_BYPASS_RULES,
  };
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Initialize log manager
const LogManager = require("./src/helpers/logManager");

// Create logger instance
const logger = new LogManager();

try {
  crashReporter.start({
    uploadToServer: false,
    compress: false,
    companyName: "CapsWriter",
    productName: "CapsWriter AGX Client",
  });
  logger.info("Electron crash reporter started", {
    crashDumpsPath: app.getPath("crashDumps"),
  });
} catch (error) {
  logger.warn("Electron crash reporter failed to start", error?.message || error);
}

const HEADLESS_MODE = process.env.SPEECH_TRANSCRIPTION_HEADLESS === '1';
const MANAGED_STACK_MODE = process.env.CAPSWRITER_DEV_MANAGED === '1';
const MANAGED_STACK_SCRIPT = process.env.CAPSWRITER_DEV_SCRIPT || '';
let managedStackStopRequested = false;

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  if (error.code === "EPIPE") {
    return;
  }
  logger.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", { promise, reason });
});

// Import managers
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const TrayManager = require("./src/helpers/tray");
const HotkeyManager = require("./src/helpers/hotkeyManager");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const CapsLockListener = require("./src/helpers/capsLockListener");
const ProcessMonitorManager = require("./src/helpers/processMonitorManager");
const CodexTerminalManager = require("./src/helpers/codexTerminalManager");
const { Nx1QwenRouter } = require("./src/helpers/nx1QwenRouter");
const MiniCPMVoiceBridge = require("./src/helpers/minicpmVoiceBridge");
const VoiceActionManager = require("./src/helpers/voiceActionManager");
const { VoiceLearningManager } = require("./src/helpers/voiceLearningManager");
const { VoiceTeacherClassifier } = require("./src/helpers/voiceTeacherClassifier");
const { LinkBookmarkManager } = require("./src/helpers/linkBookmarkManager");
const VoiceDatasetRecorder = require("./src/helpers/voiceDatasetRecorder");
const M5VoiceBridge = require("./src/helpers/m5VoiceBridge");

// Setup production PATH for Python
function setupProductionPath() {
  logger.info('Setting up production PATH', {
    platform: process.platform,
    nodeEnv: process.env.NODE_ENV,
    currentPath: process.env.PATH
  });

  if (process.platform === 'darwin' && process.env.NODE_ENV !== 'development') {
    const commonPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/Library/Frameworks/Python.framework/Versions/3.12/bin',
      '/Library/Frameworks/Python.framework/Versions/3.11/bin',
      '/Library/Frameworks/Python.framework/Versions/3.10/bin',
      '/Library/Frameworks/Python.framework/Versions/3.9/bin',
      '/Library/Frameworks/Python.framework/Versions/3.8/bin',
      // Homebrew Python paths
      '/opt/homebrew/opt/python@3.11/bin',
      '/opt/homebrew/opt/python@3.10/bin',
      '/opt/homebrew/opt/python@3.9/bin',
      '/usr/local/opt/python@3.11/bin',
      '/usr/local/opt/python@3.10/bin',
      '/usr/local/opt/python@3.9/bin'
    ];
    
    const currentPath = process.env.PATH || '';
    const pathsToAdd = commonPaths.filter(p => !currentPath.includes(p));
    
    if (pathsToAdd.length > 0) {
      const newPath = `${currentPath}:${pathsToAdd.join(':')}`;
      process.env.PATH = newPath;
      logger.info('PATH updated', {
        addedPaths: pathsToAdd,
        newPath: newPath
      });
    } else {
      logger.info('PATH already contains all required paths');
    }
  } else if (process.platform === 'win32' && process.env.NODE_ENV !== 'development') {
    // Windows Python paths
    const commonPaths = [
      'C:\\Python311\\Scripts',
      'C:\\Python311',
      'C:\\Python310\\Scripts',
      'C:\\Python310',
      'C:\\Python39\\Scripts',
      'C:\\Python39',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python311\\Scripts',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python311',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python310\\Scripts',
      'C:\\Users\\' + require('os').userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python310'
    ];
    
    const currentPath = process.env.PATH || '';
    const pathsToAdd = commonPaths.filter(p => !currentPath.includes(p));
    
    if (pathsToAdd.length > 0) {
      const newPath = `${currentPath};${pathsToAdd.join(';')}`;
      process.env.PATH = newPath;
      logger.info('Windows PATH updated', {
        addedPaths: pathsToAdd,
        newPath: newPath
      });
    }
  }
}

// Call setup before initialization
setupProductionPath();

// Set ELECTRON_USER_DATA for Python subprocess
process.env.ELECTRON_USER_DATA = app.getPath('userData');
logger.info('ELECTRON_USER_DATA set', {
  ELECTRON_USER_DATA: process.env.ELECTRON_USER_DATA
});

// Initialize managers
const environmentManager = new EnvironmentManager();
const windowManager = new WindowManager();
const databaseManager = new DatabaseManager();
const clipboardManager = new ClipboardManager(logger);
const trayManager = new TrayManager();
const hotkeyManager = new HotkeyManager();
const capsLockListener = new CapsLockListener(logger);
const processMonitorManager = new ProcessMonitorManager(logger);
const minicpmVoiceBridge = new MiniCPMVoiceBridge({ logger });
let clipboardWatchTimer = null;
let clipboardWatchEnabled = false;
let lastClipboardText = "";
const CLIPBOARD_WATCH_INTERVAL_MS = 500;

function safeSendToMainWindow(channel, payload) {
  const win = windowManager.mainWindow;
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch (error) {
    logger.warn(`Failed to send IPC to main window: ${channel}`, error?.message || error);
    return false;
  }
}

function emitClipboardTextChanged(text) {
  logger.info("Clipboard watch emitted change", { textLength: text.length });
  safeSendToMainWindow("clipboard-text-changed", {
    text,
    ts: Date.now(),
  });
}

async function pollClipboardText() {
  if (!clipboardWatchEnabled) return;
  try {
    const text = await clipboardManager.readClipboard();
    const normalized = String(text || "").trim();
    if (!normalized) return;
    if (normalized === lastClipboardText) return;
    lastClipboardText = normalized;
    emitClipboardTextChanged(normalized);
  } catch (error) {
    logger.warn("Clipboard watch poll failed", error?.message || error);
  }
}

function startClipboardWatch() {
  if (clipboardWatchEnabled) return true;
  clipboardWatchEnabled = true;
  if (!clipboardWatchTimer) {
    clipboardWatchTimer = setInterval(() => {
      pollClipboardText();
    }, CLIPBOARD_WATCH_INTERVAL_MS);
  }
  pollClipboardText();
  logger.info("Clipboard watch started", { intervalMs: CLIPBOARD_WATCH_INTERVAL_MS });
  return true;
}

function stopClipboardWatch() {
  clipboardWatchEnabled = false;
  if (clipboardWatchTimer) {
    clearInterval(clipboardWatchTimer);
    clipboardWatchTimer = null;
  }
  logger.info("Clipboard watch stopped");
  return true;
}

function requestManagedStackShutdown() {
  if (!MANAGED_STACK_MODE || managedStackStopRequested) {
    return;
  }

  const scriptPath = MANAGED_STACK_SCRIPT.trim();
  if (!scriptPath) {
    logger.warn("Managed stack mode is enabled but CAPSWRITER_DEV_SCRIPT is empty");
    managedStackStopRequested = true;
    return;
  }

  managedStackStopRequested = true;
  try {
    const child = spawn("bash", [scriptPath, "stop"], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(scriptPath),
    });
    child.unref();
    logger.info("Requested managed CapsWriter stack shutdown", { scriptPath });
  } catch (error) {
    logger.error("Failed to request managed stack shutdown", error);
  }
}

function findLegacyCoreClientProcesses() {
  if (process.platform === "linux" || process.platform === "darwin") {
    try {
      const output = execSync("ps -eo pid,args", { encoding: "utf-8" });
      return output
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const firstSpace = line.indexOf(" ");
          if (firstSpace === -1) {
            return null;
          }
          const pid = line.slice(0, firstSpace).trim();
          const cmd = line.slice(firstSpace + 1).trim();
          return { pid, cmd };
        })
        .filter((item) => item && /\bcore_client\.py\b/.test(item.cmd));
    } catch (error) {
      logger.warn("Failed to inspect running processes for legacy core client", error.message);
      return [];
    }
  }

  if (process.platform === "win32") {
    try {
      const output = execSync(
        'wmic process where "CommandLine like \'%core_client.py%\'" get ProcessId,CommandLine /FORMAT:LIST',
        { encoding: "utf-8" }
      );
      const blocks = output
        .split(/\r?\n\r?\n/)
        .map((block) => block.trim())
        .filter(Boolean);
      return blocks
        .map((block) => {
          const lines = block.split(/\r?\n/);
          const pidLine = lines.find((line) => line.startsWith("ProcessId="));
          const cmdLine = lines.find((line) => line.startsWith("CommandLine="));
          if (!pidLine || !cmdLine) {
            return null;
          }
          return {
            pid: pidLine.replace("ProcessId=", "").trim(),
            cmd: cmdLine.replace("CommandLine=", "").trim()
          };
        })
        .filter((item) => item && /\bcore_client\.py\b/i.test(item.cmd));
    } catch (error) {
      logger.warn("Failed to inspect running processes for legacy core client", error.message);
      return [];
    }
  }

  return [];
}

async function warnIfLegacyCoreClientRunning() {
  if (HEADLESS_MODE) {
    return;
  }

  const processes = findLegacyCoreClientProcesses();
  if (!processes.length) {
    return;
  }

  const pidSummary = processes.map((p) => p.pid).join(", ");
  logger.warn("Detected legacy core_client.py process alongside GUI client", { pids: pidSummary });

  await dialog.showMessageBox({
    type: "warning",
    title: "检测到旧版客户端仍在运行",
    message: "检测到 core_client.py 正在运行",
    detail:
      `core_client.py 也会监听快捷键并执行粘贴，可能导致一次输入出现两次。\n` +
      `建议先关闭旧版客户端后再使用 GUI 客户端。\n\n` +
      `检测到的进程 PID: ${pidSummary}`,
    buttons: ["我知道了"],
    defaultId: 0,
    noLink: true
  });
}

// Ensure data directory and initialize database
const dataDirectory = environmentManager.ensureDataDirectory();
databaseManager.initialize(dataDirectory);
clipboardManager.setDatabaseManager(databaseManager);
const voiceDatasetRecorder = new VoiceDatasetRecorder({ documentsDirectory: app.getPath("documents"), logger });
const codexTerminalManager = new CodexTerminalManager({ logger, dataDirectory });
const nx1QwenRouter = new Nx1QwenRouter({ logger, databaseManager });
const voiceLearningManager = new VoiceLearningManager({ logger });
const voiceTeacherClassifier = new VoiceTeacherClassifier({ logger, cwd: __dirname });
const linkBookmarkManager = new LinkBookmarkManager({ logger });
linkBookmarkManager.initializeDefaults();
const m5VoiceBridge = new M5VoiceBridge({
  logger,
  windowManager,
  clipboardManager,
  databaseManager,
  sendToRenderer: safeSendToMainWindow,
});
let rendererRecoveryActive = false;
let lastRendererHeartbeatAt = Date.now();
let rendererHeartbeatWatchdog = null;

async function recoverMainRenderer(reason, details = {}) {
  if (rendererRecoveryActive || app.isQuitting) return;
  rendererRecoveryActive = true;
  logger.error("Main renderer recovery started", { reason, details });
  m5VoiceBridge.abortAllSessions(reason);
  const current = windowManager.mainWindow;
  if (current && !current.isDestroyed()) current.destroy();
  try {
    const next = await windowManager.createMainWindow();
    trayManager.setWindows(next, windowManager.controlPanelWindow);
    lastRendererHeartbeatAt = Date.now();
    logger.info("Main renderer recovery completed", { reason });
  } catch (error) {
    logger.error("Main renderer recovery failed", error?.stack || error?.message || error);
  } finally {
    rendererRecoveryActive = false;
  }
}

windowManager.setRendererFailureHandler((reason, details) => {
  recoverMainRenderer(reason, details).catch((error) => {
    logger.error("Unhandled renderer recovery error", error?.stack || error?.message || error);
  });
});

ipcMain.on("renderer-heartbeat", (event) => {
  if (event.sender === windowManager.mainWindow?.webContents) {
    lastRendererHeartbeatAt = Date.now();
  }
});
const voiceActionManager = new VoiceActionManager({
  logger,
  clipboardManager,
  qwenRouter: nx1QwenRouter,
  teacherClassifier: voiceTeacherClassifier,
  learningManager: voiceLearningManager,
  linkBookmarkManager,
  openExternal: (url) => shell.openExternal(url)
});
let pendingVoiceQuestion = null;
const PENDING_VOICE_QUESTION_TTL_MS = 120000;

function consumePendingVoiceQuestionIfFresh() {
  if (!pendingVoiceQuestion) return null;
  if (Date.now() - Number(pendingVoiceQuestion.createdAt || 0) > PENDING_VOICE_QUESTION_TTL_MS) {
    pendingVoiceQuestion = null;
    return null;
  }
  const pending = pendingVoiceQuestion;
  pendingVoiceQuestion = null;
  return pending;
}

function rememberPendingVoiceQuestion(prompt, result) {
  if (result?.actionType !== "ask") return;
  pendingVoiceQuestion = {
    text: String(prompt || "").trim(),
    question: result?.message || result?.reason || "请补充一下",
    createdAt: Date.now()
  };
}

codexTerminalManager.on("update", (payload) => {
  if (payload.phase === "completed" || payload.phase === "error") {
    windowManager.showFloatingBall({ rememberActiveWindow: false });
  }
  safeSendToMainWindow("codex-voice-update", payload);
  if ((payload.phase === "completed" || payload.phase === "error") && Notification.isSupported()) {
    try {
      new Notification({
        title: payload.phase === "completed" ? "Codex 任务已完成" : "Codex 语音任务失败",
        body: payload.preview || payload.message || "",
        silent: true
      }).show();
    } catch (error) {
      logger.warn("Failed to show Codex voice notification", error?.message || error);
    }
  }
});
codexTerminalManager.start();

// Initialize process monitor manager
processMonitorManager.setDatabaseManager(databaseManager);

// Setup IPC handlers
const ipcHandlers = new IPCHandlers({
  environmentManager,
  databaseManager,
  clipboardManager,
  windowManager,
  hotkeyManager,
  logger,
  processMonitorManager,
  linkBookmarkManager,
  voiceDatasetRecorder,
});

ipcMain.handle("set-clipboard-watch-enabled", (_event, enabled) => {
  const next = !!enabled;
  if (next) {
    return startClipboardWatch();
  }
  return stopClipboardWatch();
});

ipcMain.handle("get-clipboard-watch-enabled", () => {
  return { success: true, enabled: clipboardWatchEnabled };
});

ipcMain.handle("set-caps-min-hold-ms", (_event, ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) {
    return { success: false, error: "Invalid value" };
  }
  capsLockListener.minHoldMs = value;
  return { success: true, minHoldMs: value };
});

ipcMain.handle("get-caps-min-hold-ms", () => {
  return { success: true, minHoldMs: capsLockListener.minHoldMs };
});

ipcMain.handle("set-dictation-key-capture-enabled", (_event, enabled) => {
  capsLockListener.setDictationKeyCaptureEnabled(!!enabled);
  logger.info("Dictation key capture state changed", { enabled: !!enabled });
  return { success: true, enabled: !!enabled };
});

ipcMain.handle("set-floating-ball-input-capture-enabled", (_event, enabled) => {
  const ok = windowManager.setFloatingBallInputCaptureEnabled(!!enabled);
  logger.info("Floating ball input capture state changed", { enabled: !!enabled, ok });
  return { success: ok, enabled: !!enabled };
});

ipcMain.handle("submit-minicpm-voice-prompt", async (_event, prompt) => {
  const rawPrompt = String(prompt || "").trim();
  if (!rawPrompt) {
    logger.info("MiniCPM voice bridge ignored empty prompt");
    return {
      success: false,
      error: "Empty prompt",
      message: "没有识别到语音内容"
    };
  }

  try {
    const result = await minicpmVoiceBridge.submitVoice(rawPrompt, { source: "capswriter" });
    logger.info("MiniCPM voice bridge submitted prompt", {
      textLength: rawPrompt.length,
      port: result && result.port,
    });
    return {
      success: true,
      message: "已发送给窝窝头",
      ...result,
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    logger.warn("MiniCPM voice bridge submit failed", { message });
    return {
      success: false,
      error: message,
      message,
    };
  }
});

ipcMain.handle("interrupt-minicpm-voice", async () => {
  try {
    const result = await minicpmVoiceBridge.interruptVoice();
    logger.info("MiniCPM voice bridge interrupted current turn", {
      port: result && result.port,
    });
    return {
      success: true,
      ...result,
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    logger.warn("MiniCPM voice bridge interrupt failed", { message });
    return {
      success: false,
      error: message,
      message,
    };
  }
});

ipcMain.handle("submit-codex-voice-prompt", async (_event, prompt) => {
  const rawPrompt = String(prompt || "").trim();
  if (!rawPrompt) {
    pendingVoiceQuestion = null;
    logger.info("Codex voice route ignored empty prompt");
    return {
      handled: true,
      success: false,
      handledByVoiceAction: true,
      actionType: "ignored",
      matchSource: "empty_prompt",
      error: "Empty prompt",
      message: "没有识别到语音内容"
    };
  }
  const activeWindowId = windowManager.previousActiveWindow || "";
  const pendingQuestion = consumePendingVoiceQuestionIfFresh();
  const routedPrompt = pendingQuestion?.text
    ? `${pendingQuestion.text}。补充：${rawPrompt}`
    : rawPrompt;
  const codexSession = codexTerminalManager.getVoiceRouteContext();
  const actionResult = await voiceActionManager.handlePrompt(routedPrompt, {
    activeWindowId,
    context: {
      codexSession,
      activeWindowIsCodexTerminal: codexTerminalManager.isCodexVoiceWindow(activeWindowId),
      pendingVoiceQuestion: pendingQuestion
    }
  });
  if (actionResult.handled) {
    rememberPendingVoiceQuestion(routedPrompt, actionResult);
    logger.info("Codex voice route handled by voice action", {
      actionType: actionResult.actionType || "",
      intentId: actionResult.intentId || "",
      matchSource: actionResult.matchSource || "",
      message: actionResult.message || "",
      pendingQuestion: Boolean(pendingQuestion)
    });
    return actionResult;
  }
  const codexResult = await codexTerminalManager.submitPrompt(routedPrompt);
  pendingVoiceQuestion = null;
  return {
    ...codexResult,
    handledByVoiceAction: false,
    fallback: actionResult.fallback || "codex_terminal",
    activeWindow: actionResult.activeWindow || null,
    confidence: actionResult.confidence,
    matchSource: actionResult.matchSource,
    learningCandidate: actionResult.learningCandidate || null
  };
});

ipcMain.handle("get-voice-action-intent-manifest", async () => {
  return voiceActionManager.getIntentManifest();
});

ipcMain.handle("execute-voice-action-intent", async (_event, payload = {}) => {
  const activeWindowId = windowManager.previousActiveWindow || "";
  const text = String(payload.text || "").trim();
  logger.info("Codex voice server intent received", {
    intentId: payload.intentId || "",
    textLength: text.length,
    textPreview: text.slice(0, 80),
    actionType: payload.actionType || ""
  });
  if (!text) {
    pendingVoiceQuestion = null;
    logger.info("Codex voice route ignored empty server intent", {
      intentId: payload.intentId || ""
    });
    return {
      handled: true,
      success: false,
      handledByVoiceAction: true,
      intentId: payload.intentId || "",
      actionType: "ignored",
      matchSource: "empty_prompt",
      error: "Empty prompt",
      message: "没有识别到语音内容"
    };
  }
  const localDeterministicResult = await voiceActionManager.executeDeterministicIntentOverride(text, {
    activeWindowId,
    serverIntentId: payload.intentId || ""
  });
  if (localDeterministicResult?.handledByVoiceAction) {
    logger.info("Codex voice route preferred local deterministic intent over server intent", {
      serverIntentId: payload.intentId || "",
      localIntentId: localDeterministicResult.intentId || "",
      matchSource: localDeterministicResult.matchSource || "",
      message: localDeterministicResult.message || ""
    });
    return localDeterministicResult;
  }
  const localLinkResult = await voiceActionManager.executeLinkBookmarkOverride(text, {
    activeWindowId,
    serverIntentId: payload.intentId || ""
  });
  if (localLinkResult?.handledByVoiceAction) {
    logger.info("Codex voice route preferred local link bookmark over server intent", {
      serverIntentId: payload.intentId || "",
      localIntentId: localLinkResult.intentId || "",
      matchSource: localLinkResult.matchSource || "",
      message: localLinkResult.message || ""
    });
    return localLinkResult;
  }
  return await voiceActionManager.executeIntentById(payload.intentId, {
    text,
    activeWindowId
  });
});

ipcMain.handle("submit-codex-terminal-prompt", async (_event, prompt) => {
  const activeWindowId = windowManager.previousActiveWindow || "";
  const codexResult = await codexTerminalManager.submitPrompt(prompt, {
    preferredWindowId: activeWindowId
  });
  pendingVoiceQuestion = null;
  return {
    ...codexResult,
    handledByVoiceAction: false,
    fallback: "codex_terminal",
    activeWindow: activeWindowId || null
  };
});

ipcMain.handle("learn-voice-route-shortcut", async (_event, candidate = {}) => {
  return voiceActionManager.learnShortcut(candidate || {});
});

ipcMain.handle("cancel-codex-voice-route", async (_event, payload = "user_escape") => {
  const reason = typeof payload === "object" && payload !== null
    ? String(payload.reason || "user_escape")
    : String(payload || "user_escape");
  const interruptCodex = Boolean(
    typeof payload === "object" && payload !== null && payload.interruptCodex
  );
  pendingVoiceQuestion = null;
  const teacherCancelled = voiceActionManager.cancelActiveRouting(reason);
  const codexCancel = interruptCodex
    ? await codexTerminalManager.cancelActiveTask(reason)
    : { cancelled: false, error: "" };
  logger.info("Codex voice route cancel requested", {
    reason,
    interruptCodex,
    teacherCancelled,
    codexCancelled: !!codexCancel?.cancelled,
    codexError: codexCancel?.error || ""
  });
  return {
    success: true,
    interruptCodex,
    teacherCancelled,
    codexCancelled: !!codexCancel?.cancelled,
    codexError: codexCancel?.error || ""
  };
});

ipcMain.handle("open-codex-debug-terminal", async () => {
  try {
    const paneTarget = await codexTerminalManager.ensureTerminalWindow();
    return {
      success: true,
      paneTarget,
      sessionName: codexTerminalManager.sessionName,
      windowId: ""
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("resolve-nx1-qwen-router", async (_event, options = {}) => {
  return await nx1QwenRouter.resolveEndpoint(options || {});
});

ipcMain.handle("test-nx1-qwen-router", async () => {
  return await nx1QwenRouter.chatCompletion(
    [{ role: "user", content: "只回答 SERVER-LLM-OK" }],
    { temperature: 0, max_tokens: 12 }
  );
});

ipcMain.handle("submit-nx1-qwen-chat", async (_event, messages, options = {}) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { success: false, error: "messages 不能为空" };
  }
  return await nx1QwenRouter.chatCompletion(messages, options || {});
});

ipcMain.handle("route-nx1-qwen-terminal-request", async (_event, payload = {}) => {
  return await nx1QwenRouter.routeTerminalRequest(payload || {});
});

ipcMain.handle("m5-voice-recording-result", async (_event, payload = {}) => {
  return m5VoiceBridge.handleRendererResult(payload);
});

// Main app startup function
async function startApp() {
  logger.info('Application starting', {
    nodeEnv: process.env.NODE_ENV,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    appVersion: app.getVersion(),
    headless: HEADLESS_MODE
  });

  // Log system info
  logger.info('System info', logger.getSystemInfo());

  // Wait for Vite dev server in development
  if (process.env.NODE_ENV === "development") {
    logger.info('Development mode, waiting for Vite...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Show dock on macOS
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
    logger.info('macOS Dock shown');
  }

  // Create main window
  try {
    logger.info('Creating main window...');
    await windowManager.createMainWindow();
    logger.info('Main window created successfully');
  } catch (error) {
    logger.error("Failed to create main window:", error);
  }

  // Create control panel window
  if (HEADLESS_MODE) {
    logger.info('Headless mode, skipping control panel window creation');
  } else {
    try {
      logger.info('Creating control panel window...');
      await windowManager.createControlPanelWindow();
      logger.info('Control panel window created successfully');
    } catch (error) {
      logger.error("Failed to create control panel window:", error);
    }
    try {
      logger.info('Creating link directory window...');
      await windowManager.createLinkDirectoryWindow();
      windowManager.showLinkDirectoryWindow();
      logger.info('Link directory window created successfully');
    } catch (error) {
      logger.error("Failed to create link directory window:", error);
    }
  }

  await warnIfLegacyCoreClientRunning();

  // Create system tray
  logger.info('Creating system tray...');
  trayManager.setWindows(
    windowManager.mainWindow,
    windowManager.controlPanelWindow
  );
  trayManager.setCreateControlPanelCallback(() =>
    windowManager.createControlPanelWindow()
  );
  trayManager.setCreateSettingsWindowCallback(() =>
    windowManager.showSettingsWindow()
  );
  await trayManager.createTray();
  logger.info('System tray created successfully');

  // Setup dictation hold-key listener
  logger.info('Setting up dictation hold-key listener...');
  capsLockListener.setOnCapsLockDown(async (payload = {}) => {
    const triggerId = payload.trigger_id || 'keyboard';
    logger.info(`${capsLockListener.getDictationKeyDisplayName()} pressed - showing floating ball and starting recording`);
    windowManager.showFloatingBall({
      rememberActiveWindow: !m5VoiceBridge.hasActiveRecordings(),
    });
    const routed = await m5VoiceBridge.handleHostTriggerDown(
      triggerId,
      windowManager.previousActiveWindow || ''
    );
    if (!routed.handled) {
      if (routed.busy || triggerId.startsWith('minijoy_bt')) {
        safeSendToMainWindow('external-recording-error', {
          trigger_id: triggerId,
          error: routed.busy ? '录音任务已满，请稍后重试' : '对应的 MiniJoy 蓝牙麦克风当前不可用',
        });
        setTimeout(() => windowManager.hideFloatingBall(), 1600);
        return;
      }
      safeSendToMainWindow('caps-lock-down', payload);
    }
  });

  capsLockListener.setOnCapsLockUp(async (payload = {}) => {
    const triggerId = payload.trigger_id || 'keyboard';
    logger.info(`${capsLockListener.getDictationKeyDisplayName()} released - stopping recording, keep floating ball visible for result`);
    
    // Restore the window that was active before the floating recorder appeared.
    if (windowManager.previousActiveWindow) {
      clipboardManager.setTargetWindow(windowManager.previousActiveWindow);
    }
    
    // 然后发送停止录音事件
    const routed = payload.forced
      ? { handled: m5VoiceBridge.abortHostTrigger(triggerId, payload.reason || 'input_device_closed') }
      : await m5VoiceBridge.handleHostTriggerUp(triggerId);
    if (!routed.handled) {
      safeSendToMainWindow('caps-lock-up', payload);
    }

    if (process.platform !== 'linux' && capsLockListener.isCapsLockDictationKey()) {
      setTimeout(() => {
        try {
          if (capsLockListener.restoreCapsLockState()) {
            logger.info('Caps Lock restored after release');
          }
        } catch (error) {
          logger.warn('Failed to restore Caps Lock state:', error?.message || error);
        }
      }, 10);
    }
  });

  capsLockListener.setOnCodexHoldDown(() => {
    logger.info(`${capsLockListener.getCodexKeyDisplayName()} pressed - showing floating ball and starting Codex voice recording`);
    windowManager.showFloatingBall();
    safeSendToMainWindow('codex-hold-down');
  });

  capsLockListener.setOnCodexHoldUp(() => {
    logger.info(`${capsLockListener.getCodexKeyDisplayName()} released - stopping Codex voice recording`);
    if (windowManager.previousActiveWindow) {
      clipboardManager.setTargetWindow(windowManager.previousActiveWindow);
    }
    safeSendToMainWindow('codex-hold-up');

    if (process.platform !== 'linux' && capsLockListener.isCapsLockCodexKey()) {
      setTimeout(() => {
        try {
          if (capsLockListener.restoreCapsLockState()) {
            logger.info('Caps Lock restored after Codex hold release');
          }
        } catch (error) {
          logger.warn('Failed to restore Caps Lock state after Codex hold:', error?.message || error);
        }
      }, 10);
    }
  });

  capsLockListener.setOnDictationCancel((payload = {}) => {
    logger.info('Dictation cancel requested', payload);
    const reason = payload?.reason || 'global_escape';
    voiceActionManager.cancelActiveRouting(reason);
    safeSendToMainWindow('dictation-cancel-requested', payload);
  });

  capsLockListener.setOnDictationConfirm(() => {
    logger.info('Dictation confirm requested');
    safeSendToMainWindow('dictation-confirm-requested');
  });

  let capsLockListenerStarted = false;
  const macAccessibilityGranted =
    process.platform !== 'darwin' ||
    systemPreferences.isTrustedAccessibilityClient(false);

  if (!macAccessibilityGranted) {
    logger.warn(
      'macOS Accessibility permission is required for global hold-key listening; listener startup deferred'
    );
    systemPreferences.isTrustedAccessibilityClient(true);
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    ).catch((error) => {
      logger.warn('Failed to open macOS Accessibility settings:', error?.message || error);
    });
  } else {
    capsLockListenerStarted = capsLockListener.start();
  }

  if (capsLockListenerStarted) {
    logger.info(`${capsLockListener.getDictationKeyDisplayName()} listener started`);
  } else {
    logger.warn('Dictation hold-key listener unavailable, 按住唤醒功能已禁用');
  }

  m5VoiceBridge.start();

  if (!rendererHeartbeatWatchdog) {
    rendererHeartbeatWatchdog = setInterval(() => {
      if (!windowManager.mainWindow || rendererRecoveryActive) return;
      if (Date.now() - lastRendererHeartbeatAt > 6000) {
        recoverMainRenderer("renderer_heartbeat_timeout", {
          silentForMs: Date.now() - lastRendererHeartbeatAt,
        }).catch(() => {});
      }
    }, 2000);
    rendererHeartbeatWatchdog.unref?.();
  }

  logger.info('Application startup complete');
}

// App ready handler
app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy(buildSessionProxyConfig());
  } catch (error) {
    logger.warn('Realtime ASR proxy bypass was not applied', error?.message || error);
  }
  startApp();

  withTimeout(
    session.defaultSession.resolveProxy('https://asr.yuanspaces.com/'),
    ASR_PROXY_CONFIG_TIMEOUT_MS,
    'proxy resolution timed out',
  ).then((asrProxy) => {
    const fields = { host: 'asr.yuanspaces.com', result: asrProxy };
    if (/^DIRECT(?:;|$)/i.test(String(asrProxy).trim())) {
      logger.info('Realtime ASR proxy bypass verified', fields);
    } else {
      logger.warn('Realtime ASR proxy bypass is not direct', fields);
    }
  }).catch((error) => {
    logger.warn('Realtime ASR proxy resolution failed', error?.message || error);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  codexTerminalManager.stop();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    windowManager.createMainWindow();
  }
});

app.on("will-quit", () => {
  app.isQuitting = true;
  if (rendererHeartbeatWatchdog) clearInterval(rendererHeartbeatWatchdog);
  stopClipboardWatch();
  m5VoiceBridge.stop();
  globalShortcut.unregisterAll();
  processMonitorManager.destroy();
  requestManagedStackShutdown();
});

// Export managers for external use
module.exports = {
  environmentManager,
  windowManager,
  databaseManager,
  clipboardManager,
  trayManager,
  hotkeyManager,
  logger,
  processMonitorManager
};
