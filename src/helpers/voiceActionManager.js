const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { isHttpUrl } = require("./linkBookmarkManager");
const { VoiceLearningManager, normalizePhrase } = require("./voiceLearningManager");
const { VoiceTeacherClassifier } = require("./voiceTeacherClassifier");

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "speech-transcription", "voice-actions.json");
const DEFAULT_SHORTCUTS_PATH = path.join(os.homedir(), ".config", "speech-transcription", "voice-route-shortcuts.json");
const DEFAULT_CONFIDENCE_THRESHOLD = 0.78;
const ENTER_KEY_SETTLE_MS = 120;
const TERMINAL_TAB_SETTLE_MS = 420;
const MAX_KEY_SEQUENCE_REPEAT = 10;
const MAX_SHELL_REPEAT = 10;
const UNKNOWN_VOICE_COMMAND_MESSAGE = "未识别为预设语音指令";
const CHINESE_DIGITS = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  俩: 2,
  贰: 2,
  三: 3,
  仨: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9
};
const DEFAULT_BUILTIN_INTENTS = [
  {
    id: "capture_hotwords",
    description: "从客户端剪贴板提取热词，并加入当前会话热词",
    examples: [
      "学习一下",
      "请学习一下",
      "用学习一下",
      "帮我学习一下",
      "帮我学一下",
      "学一下",
      "记一下",
      "帮我记一下",
      "捕获热词",
      "提取热词",
      "读取热词",
      "学习热词",
      "记住热词",
      "加入热词",
      "从剪贴板学习一下",
      "剪贴板学习一下",
      "把剪贴板学习一下",
      "hotword",
      "hot key"
    ],
    allowModelFallback: true,
    action: { type: "capture_hotwords" }
  },
  {
    id: "translate_clipboard_to_zh",
    description: "把剪贴板内容翻译成中文并粘贴到当前窗口",
    examples: [
      "翻译成中文",
      "翻译剪贴板",
      "翻译剪贴板成中文",
      "把剪贴板翻译成中文",
      "把选中的内容翻译成中文",
      "英文翻译成中文",
      "复制内容翻译成中文"
    ],
    allowModelFallback: true,
    action: { type: "translate_clipboard", translateTarget: "zh" }
  },
  {
    id: "open_gnome_terminal",
    description: "打开一个新的终端窗口",
    examples: [
      "打开终端",
      "打开一个终端",
      "新建终端",
      "开一个命令行",
      "打开命令行窗口",
      "给我开个命令行"
    ],
    allowModelFallback: false,
    action: { type: "shell", command: "gnome-terminal", args: [] }
  },
  {
    id: "reply_confirm",
    description: "输入确认并回车",
    examples: [
      "回复确认",
      "输入确认",
      "发送确认",
      "帮我回复确认",
      "用肯定答复一下",
      "给对方一个肯定答复"
    ],
    allowModelFallback: true,
    action: { type: "type_text", text: "确认", submit: "enter" }
  },
  {
    id: "open_vscode",
    description: "用 VS Code 打开当前终端所在目录",
    examples: [
      "用 VS Code 打开这个目录",
      "当前目录用 code 打开",
      "把这个终端所在目录开到 vscode",
      "在这里启动 VS Code",
      "在当前终端下打开 VS Code",
      "在这个终端输入 code $PWD",
      "在这个终端输入 code PWD"
    ],
    allowModelFallback: true,
    context: { requireActiveTerminal: true },
    action: { type: "terminal_prompt", prompt: "code $PWD" }
  },
  {
    id: "move_window_to_right_workspace",
    description: "把当前窗口移动到右边工作空间",
    examples: [
      "把这个窗口移到右边工作空间去",
      "把这个窗口移动到右边的工作空间",
      "把当前窗口移到右边 workspace",
      "把浏览器向右移动两个空间",
      "把终端往右挪两格 workspace",
      "移动这个窗口到右侧工作区",
      "把这个窗口挪到右边的工作区"
    ],
    allowModelFallback: true,
    action: { type: "key_sequence", xdotoolKeys: ["shift+super+Right"] }
  },
  {
    id: "move_window_to_left_workspace",
    description: "把当前窗口移动到左边工作空间",
    examples: [
      "把这个窗口移到左边工作空间去",
      "把这个窗口移动到左边的工作空间",
      "把当前窗口移到左边 workspace",
      "把对话框向左移动两个空间",
      "把 Windows 往左挪两格 workspace",
      "移动这个窗口到左侧工作区",
      "把这个窗口挪到左边的工作区"
    ],
    allowModelFallback: true,
    action: { type: "key_sequence", xdotoolKeys: ["shift+super+Left"] }
  },
  {
    id: "summarize_current_terminal",
    description: "在当前终端输入总结终端输出的提示",
    examples: [
      "总结这个终端刚才发生了什么",
      "把当前终端的内容概括一下",
      "看看这个终端现在卡在哪里",
      "帮我总结一下终端输出"
    ],
    allowModelFallback: true,
    context: { requireActiveTerminal: true },
    action: {
      type: "terminal_prompt",
      prompt: "请总结当前终端最近输出，说明发生了什么、是否有错误、下一步建议是什么。"
    }
  },
  {
    id: "add_voice_intent",
    description: "打开新增语音意图审阅流程",
    examples: [
      "新增一个语音快捷指令",
      "添加一个语音意图",
      "帮我创建一个语音命令",
      "进入语音意图配置"
    ],
    allowModelFallback: true,
    action: { type: "open_intent_review" }
  }
];

function expandHome(value) {
  return String(value || "").replace(/^~(?=$|\/)/, os.homedir());
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

function parseChineseInteger(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, text)) {
    return CHINESE_DIGITS[text];
  }
  if (/^[十拾]$/.test(text)) return 10;

  const tenMatch = text.match(/^([一壹二两俩贰三仨叁四肆五伍六陆七柒八捌九玖])?[十拾]([一壹二两俩贰三仨叁四肆五伍六陆七柒八捌九玖])?$/);
  if (tenMatch) {
    const tens = tenMatch[1] ? CHINESE_DIGITS[tenMatch[1]] : 1;
    const ones = tenMatch[2] ? CHINESE_DIGITS[tenMatch[2]] : 0;
    return tens * 10 + ones;
  }

  return null;
}

function normalizeRepeat(value, maxRepeat) {
  const repeat = Number(value);
  if (!Number.isFinite(repeat) || repeat < 1) return 1;
  return Math.min(maxRepeat, Math.floor(repeat));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class VoiceActionManager {
  constructor({
    logger = null,
    clipboardManager = null,
    qwenRouter = null,
    teacherClassifier = null,
    learningManager = null,
    linkBookmarkManager = null,
    openExternal = null,
    configPath = ""
  } = {}) {
    this.logger = logger;
    this.clipboardManager = clipboardManager;
    this.qwenRouter = qwenRouter;
    this.teacherClassifier = teacherClassifier || new VoiceTeacherClassifier({ logger });
    this.learningManager = learningManager || new VoiceLearningManager({ logger });
    this.linkBookmarkManager = linkBookmarkManager;
    this.openExternal = openExternal;
    this.configPath = expandHome(
      configPath || process.env.CAPSWRITER_VOICE_ACTIONS_PATH || DEFAULT_CONFIG_PATH
    );
    this.cancelGeneration = 0;
    this.activeActionCount = 0;
  }

  async handlePrompt(prompt, { activeWindowId = "", context = {} } = {}) {
    const text = String(prompt || "").trim();
    if (!text) {
      return { handled: true, success: false, error: "Empty prompt" };
    }

    const cancelGeneration = this.cancelGeneration;
    const config = this.loadConfig();
    const shortcuts = this.learningManager.loadShortcuts();
    const activeWindow = this.resolveActiveWindowForVoiceRoute(
      this.getActiveWindowInfo(activeWindowId),
      context
    );
    const match = await this.matchIntent(text, config, activeWindow, shortcuts, context);
    if (this.isRoutingCancelled(cancelGeneration)) {
      return this.cancelledResult(null, { text, match, activeWindow });
    }

    if (match.shortcut?.id) {
      this.learningManager.markUsed(match.shortcut.id);
    }
    this.learningManager.recordTeacherDecision({ phrase: text, match, activeWindow, context });

    if (match.routeType === "codex_terminal") {
      if (this.isRoutingCancelled(cancelGeneration)) {
        return this.cancelledResult(null, { text, match, activeWindow });
      }
      return {
        handled: false,
        success: true,
        fallback: "codex_terminal",
        activeWindow,
        confidence: match.confidence,
        matchSource: match.source,
        learningCandidate: this.buildLearningCandidate(text, match)
      };
    }

    if (this.shouldOpenIntentDraftReview(match)) {
      const draftCandidate = this.buildIntentDraftCandidate(text, match);
      this.learningManager.recordIntentDraft(draftCandidate);
      await this.launchIntentDraftReview(draftCandidate);
      return {
        handled: true,
        success: true,
        handledByVoiceAction: true,
        actionType: "draft_intent",
        confidence: match.confidence || 0,
        matchSource: match.source,
        message: "已打开新语音意图审阅终端",
        activeWindow,
        intentDraftCandidate: draftCandidate
      };
    }

    if (match.routeType === "ask") {
      return {
        handled: true,
        success: true,
        handledByVoiceAction: true,
        actionType: "ask",
        confidence: match.confidence || 0,
        matchSource: match.source,
        message: match.question || match.preview || match.reason || "这条语音指令需要再确认一下",
        activeWindow
      };
    }

    if (match.intent) {
      if (this.requiresManualConfirmation(match)) {
        return {
          handled: true,
          success: true,
          handledByVoiceAction: true,
          intentId: match.intent.id,
          actionType: "confirmation_required",
          confidence: match.confidence,
          matchSource: match.source,
          message: match.preview || `需要确认后执行：${match.intent.description || match.intent.id}`,
          activeWindow
        };
      }
      return await this.executeIntent(match.intent, {
        text,
        match,
        activeWindow,
        config,
        cancelGeneration
      });
    }

    if (this.shouldDictateToTerminal(config, activeWindow)) {
      await this.pasteToActiveWindow(text, activeWindow.windowId);
      return {
        handled: true,
        success: true,
        handledByVoiceAction: true,
        fallback: "dictation",
        actionType: "dictation",
        message: "已粘贴到当前终端",
        activeWindow
      };
    }

    return {
      handled: true,
      success: true,
      handledByVoiceAction: true,
      actionType: "ask",
      confidence: match.confidence || 0,
      matchSource: match.source || "unrecognized",
      message: match.reason || UNKNOWN_VOICE_COMMAND_MESSAGE,
      activeWindow,
      routerError: match.routerError || null
    };
  }

  resolveActiveWindowForVoiceRoute(activeWindow, context) {
    const codexSession = context?.codexSession || {};
    const shouldUseCodexWindow =
      context?.activeWindowIsCodexTerminal ||
      (activeWindow?.isUnknownWindow && codexSession.windowAlive && codexSession.windowId);

    if (!shouldUseCodexWindow) {
      return activeWindow;
    }

    return {
      ...activeWindow,
      windowId: String(codexSession.windowId || activeWindow.windowId || ""),
      windowClass: codexSession.windowClass || activeWindow.windowClass || "ptyxis",
      windowTitle: codexSession.windowTitle || activeWindow.windowTitle || "CapsWriter Codex Voice",
      isTerminal: true,
      isCodexTerminal: true,
      isUnknownWindow: false
    };
  }

  learnShortcut(candidate) {
    return this.learningManager.learnShortcut(candidate);
  }

  cancelActiveRouting(reason = "cancelled") {
    this.cancelGeneration += 1;
    const hadActiveAction = this.activeActionCount > 0;
    const teacherCancelled = this.teacherClassifier?.cancelActive
      ? this.teacherClassifier.cancelActive(reason)
      : false;
    return Boolean(hadActiveAction || teacherCancelled);
  }

  isRoutingCancelled(cancelGeneration) {
    return Number.isFinite(cancelGeneration) && cancelGeneration !== this.cancelGeneration;
  }

  loadConfig() {
    try {
      const data = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      const defaults = data && typeof data.defaults === "object" ? data.defaults : {};
      const intents = Array.isArray(data?.intents) ? data.intents.filter((intent) => intent && intent.action) : [];
      return {
        version: data?.version || 1,
        defaults: {
          fallbackAction: defaults.fallbackAction || "unrecognized",
          terminalCapsMode: defaults.terminalCapsMode || "dictation",
          confidenceThreshold: normalizeNumber(defaults.confidenceThreshold, DEFAULT_CONFIDENCE_THRESHOLD)
        },
        intents: this.mergeBuiltinIntents(intents)
      };
    } catch (error) {
      this.logWarn("Failed to load voice actions config", error?.message || error);
      return {
        version: 1,
        defaults: {
          fallbackAction: "unrecognized",
          terminalCapsMode: "dictation",
          confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD
        },
        intents: this.mergeBuiltinIntents([])
      };
    }
  }

  mergeBuiltinIntents(intents) {
    const merged = Array.isArray(intents) ? [...intents] : [];
    const existingIds = new Set(merged.map((intent) => intent?.id).filter(Boolean));
    for (const builtin of DEFAULT_BUILTIN_INTENTS) {
      if (!existingIds.has(builtin.id)) {
        merged.push(builtin);
      }
    }
    return merged;
  }

  getIntentManifest() {
    const config = this.loadConfig();
    return {
      success: true,
      confidenceThreshold: config.defaults.confidenceThreshold,
      intents: config.intents.map((intent) => {
        const action = intent.action || {};
        const actionType = String(action.type || "");
        const highRiskAction = ["shell", "terminal_prompt", "type_text", "key_sequence", "open_link_bookmark", "codex_terminal"].includes(actionType);
        const allowModelFallback =
          typeof intent.allowModelFallback === "boolean"
            ? intent.allowModelFallback
            : typeof intent.allow_model_fallback === "boolean"
              ? intent.allow_model_fallback
              : !highRiskAction;
        return {
          id: intent.id,
          description: intent.description || "",
          examples: Array.isArray(intent.examples) ? intent.examples : [],
          action_type: actionType,
          allow_model_fallback: allowModelFallback
        };
      }).filter((intent) => intent.id && intent.action_type)
    };
  }

  async executeIntentById(intentId, { text = "", activeWindowId = "" } = {}) {
    const normalizedText = String(text || "").trim();
    const config = this.loadConfig();
    const activeWindow = this.getActiveWindowInfo(activeWindowId);
    const intent = config.intents.find((candidate) => candidate.id === intentId);
    if (!normalizedText) {
      return {
        handled: true,
        success: false,
        handledByVoiceAction: true,
        intentId,
        actionType: intent?.action?.type || "ignored",
        matchSource: "empty_prompt",
        error: "Empty prompt",
        message: "没有识别到语音内容",
        activeWindow
      };
    }
    if (!intent) {
      return {
        handled: true,
        success: false,
        handledByVoiceAction: true,
        intentId,
        error: `Unknown intent: ${intentId}`,
        activeWindow
      };
    }
    if (!this.isIntentAllowedInContext(intent, activeWindow)) {
      return {
        handled: true,
        success: false,
        handledByVoiceAction: true,
        intentId,
        actionType: intent.action?.type || "",
        error: "当前窗口不满足该语音指令的执行条件",
        activeWindow
      };
    }
    if (intent.id === "open_gnome_terminal" && !this.looksLikeExplicitTerminalOpenRequest(normalizedText)) {
      return {
        handled: true,
        success: false,
        handledByVoiceAction: true,
        intentId,
        actionType: intent.action?.type || "shell",
        matchSource: "ambiguous_program",
        error: "Ambiguous terminal request",
        message: "没有明确指定要打开终端，已忽略",
        activeWindow
      };
    }
    return await this.executeIntent(intent, {
      text: normalizedText,
      match: {
        confidence: 1,
        source: "server"
      },
      activeWindow,
      config
    });
  }

  async executeLinkBookmarkOverride(text, { activeWindowId = "", serverIntentId = "" } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return null;

    const config = this.loadConfig();
    const activeWindow = this.getActiveWindowInfo(activeWindowId);
    const linkMatch = await this.matchLinkBookmark(normalizedText, config);
    const intent = linkMatch?.intent;
    if (intent?.action?.type !== "open_link_bookmark") {
      return null;
    }

    return await this.executeIntent(intent, {
      text: normalizedText,
      match: {
        confidence: linkMatch.confidence,
        source: linkMatch.source,
        serverIntentId
      },
      activeWindow,
      config
    });
  }

  async executeDeterministicIntentOverride(text, { activeWindowId = "", serverIntentId = "" } = {}) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) return null;

    const config = this.loadConfig();
    const activeWindow = this.getActiveWindowInfo(activeWindowId);
    const keywordMatch = this.matchProgramRule(normalizedText, config.intents, activeWindow);
    const localIntent = keywordMatch?.intent;
    if (!localIntent?.id || localIntent.id === serverIntentId) {
      return null;
    }
    if (!this.isIntentAllowedInContext(localIntent, activeWindow)) {
      return null;
    }
    const actionType = String(localIntent.action?.type || "");
    const deterministicActionTypes = new Set([
      "shell",
      "terminal_prompt",
      "key_sequence",
      "type_text",
      "translate_clipboard",
      "open_intent_review"
    ]);
    if (!deterministicActionTypes.has(actionType)) {
      return null;
    }

    return await this.executeIntent(localIntent, {
      text: normalizedText,
      match: {
        confidence: keywordMatch.confidence || 1,
        source: keywordMatch.source || "keyword",
        serverIntentId
      },
      activeWindow,
      config
    });
  }

  async matchIntent(text, config, activeWindow, shortcuts = [], context = {}) {
    const shortcut = this.matchShortcut(text, shortcuts);
    if (shortcut) {
      if (shortcut.routeType === "codex_terminal") {
        return { routeType: "codex_terminal", confidence: 1, source: "shortcut", shortcut };
      }
      const intent = config.intents.find((candidate) => candidate.id === shortcut.intentId);
      if (intent) {
        return { routeType: "intent", intent, confidence: 1, source: "shortcut", shortcut };
      }
      return { routeType: "ask", confidence: 0, source: "invalid_shortcut", reason: "快捷话术指向的 intent 不存在" };
    }

    const keywordMatch = this.matchProgramRule(text, config.intents, activeWindow);
    if (keywordMatch) {
      return keywordMatch;
    }

    const exact = this.matchIntentByExample(text, config.intents);
    if (exact) {
      return { routeType: "intent", intent: exact, confidence: 1, source: "example" };
    }

    const linkMatch = await this.matchLinkBookmark(text, config);
    if (linkMatch) {
      return linkMatch;
    }

    if (this.looksLikeCodexFollowup(text, context)) {
      return {
        routeType: "ask",
        confidence: 0,
        source: "context_followup_disabled",
        learnable: false,
        reason: UNKNOWN_VOICE_COMMAND_MESSAGE
      };
    }

    if (config.defaults.fallbackAction === "codex_terminal") {
      const teacherMatch = await this.matchWithTeacher(text, config, activeWindow, shortcuts, context);
      if (teacherMatch.source === "teacher" && teacherMatch.routeType !== "teacher_unavailable") {
        return teacherMatch;
      }
    }

    const modelMatch = await this.matchIntentWithModel(text, config, activeWindow);
    if (modelMatch.intent) {
      return modelMatch;
    }

    if (modelMatch.routeType === "ask") {
      return modelMatch;
    }

    return {
      routeType: "ask",
      intent: null,
      confidence: 0,
      source: modelMatch.source || "unrecognized",
      reason: UNKNOWN_VOICE_COMMAND_MESSAGE,
      routerError: modelMatch.routerError || null
    };
  }

  matchShortcut(text, shortcuts) {
    const normalizedText = normalizePhrase(text);
    if (!normalizedText) return null;

    return (shortcuts || []).find((shortcut) => {
      const phrases = shortcut.phrases || (shortcut.phrase ? [shortcut.phrase] : []);
      const normalizedPhrases = shortcut.normalizedPhrases || phrases.map(normalizePhrase);
      return normalizedPhrases.some((phrase) => {
        if (!phrase) return false;
        if (normalizedText === phrase) return true;
        return phrase.length >= 4 && normalizedText.includes(phrase);
      });
    }) || null;
  }

  matchIntentByExample(text, intents) {
    const normalizedText = normalizePhrase(text);
    if (!normalizedText) return null;

    return intents.find((intent) => {
      return (intent.examples || []).some((example) => {
        const normalizedExample = normalizePhrase(example);
        if (!normalizedExample) return false;
        if (normalizedText === normalizedExample) return true;
        return normalizedExample.length >= 4 && normalizedText.includes(normalizedExample);
      });
    }) || null;
  }

  matchProgramRule(text, intents, activeWindow) {
    const normalized = normalizePhrase(text);
    const intentById = (id) => intents.find((intent) => intent.id === id);
    const routeIntent = (id, reason, actionOverrides = null) => {
      const intent = intentById(id);
      if (!intent) return null;
      const routedIntent = actionOverrides
        ? { ...intent, action: { ...(intent.action || {}), ...actionOverrides } }
        : intent;
      return { routeType: "intent", intent: routedIntent, confidence: 1, source: "keyword", reason };
    };

    if (/(新增|增加|添加|创建|进入|打开).*(语音|快捷).*(意图|命令|指令|配置)/.test(normalized)) {
      return routeIntent("add_voice_intent", "关键词命中添加语音意图");
    }
    if (/(翻译|翻成|翻一下|译成).*(中文)|((英文|剪贴板|剪切板|复制).*(翻译|翻成|译成|中文))/.test(normalized)) {
      return routeIntent("translate_clipboard_to_zh", "关键词命中翻译剪贴板");
    }
    if (this.looksLikeExplicitTerminalOpenRequest(normalized)) {
      return routeIntent("open_gnome_terminal", "关键词命中打开终端", {
        repeat: this.extractTerminalOpenRepeat(normalized)
      });
    }
    if (/(回复|输入|发送|发).*(确认)/.test(normalized)) {
      return routeIntent("reply_confirm", "关键词命中回复确认");
    }
    const workspaceMove = this.matchWorkspaceMoveCommand(normalized);
    if (workspaceMove?.direction === "right") {
      return routeIntent("move_window_to_right_workspace", "关键词命中移动窗口到右边工作空间", {
        repeat: workspaceMove.repeat
      });
    }
    if (workspaceMove?.direction === "left") {
      return routeIntent("move_window_to_left_workspace", "关键词命中移动窗口到左边工作空间", {
        repeat: workspaceMove.repeat
      });
    }
    if (
      activeWindow?.isTerminal &&
      /(终端|输出|日志|当前).*(总结|概括|卡在哪里|卡住|阻塞|消息|内容)|((总结|概括).*(终端|输出|日志))/.test(normalized)
    ) {
      return routeIntent("summarize_current_terminal", "关键词命中总结当前终端");
    }
    return null;
  }

  matchWorkspaceMoveCommand(normalized) {
    const text = String(normalized || "");
    if (!text) return null;

    const objectPattern = /(窗口|对话框|终端|浏览器|页面|网页|应用|程序|软件|window|windows|browser|app|terminal|dialog|这个|当前|它|这一个)/;
    const movePattern = /(移|移动|挪|送|放|丢|甩|挪动|挪到|移到|移动到|切到|扔到|拖到|push|move|send)/;
    const workspacePattern = /(工作空间|工作区|workspace|workspaces|空间|桌面|格|屏)/;
    if (!objectPattern.test(text) || !movePattern.test(text) || !workspacePattern.test(text)) {
      return null;
    }

    const hasRight = /(右|右边|右侧|往右|向右|right|next)/.test(text);
    const hasLeft = /(左|左边|左侧|往左|向左|left|previous|prev)/.test(text);
    if (hasRight === hasLeft) return null;

    return {
      direction: hasRight ? "right" : "left",
      repeat: this.extractWorkspaceMoveRepeat(text)
    };
  }

  extractWorkspaceMoveRepeat(normalized) {
    const text = String(normalized || "");
    const arabicMatch = text.match(/(\d{1,2})(?:个|次|格|下|层)?(?:工作空间|工作区|workspace|workspaces|空间|桌面|格|屏)?/);
    if (arabicMatch) {
      return this.normalizeKeySequenceRepeat(Number(arabicMatch[1]));
    }

    const chineseMatch = text.match(/([一壹二两俩贰三仨叁四肆五伍六陆七柒八捌九玖十拾]{1,3})(?:个|次|格|下|层)?(?:工作空间|工作区|workspace|workspaces|空间|桌面|格|屏)?/);
    if (chineseMatch) {
      return this.normalizeKeySequenceRepeat(parseChineseInteger(chineseMatch[1]));
    }
    return 1;
  }

  normalizeKeySequenceRepeat(value) {
    return normalizeRepeat(value, MAX_KEY_SEQUENCE_REPEAT);
  }

  extractTerminalOpenRepeat(text) {
    const normalized = normalizePhrase(text);
    if (!this.looksLikeExplicitTerminalOpenRequest(normalized)) return 1;

    const terminalNoun = "(?:终端|命令行|terminal|terminals|console|shell)";
    const numberUnit = "(?:个|台|扇|页|窗口|个新|个新的)?";
    const arabicBefore = normalized.match(new RegExp(`(\\d{1,2})${numberUnit}${terminalNoun}`));
    if (arabicBefore) {
      return normalizeRepeat(Number(arabicBefore[1]), MAX_SHELL_REPEAT);
    }

    const arabicAfter = normalized.match(new RegExp(`${terminalNoun}(\\d{1,2})(?:个|台|扇|页|窗口)?`));
    if (arabicAfter) {
      return normalizeRepeat(Number(arabicAfter[1]), MAX_SHELL_REPEAT);
    }

    const chinesePattern = "([一壹二两俩贰三仨叁四肆五伍六陆七柒八捌九玖十拾]{1,3})";
    const chineseBefore = normalized.match(new RegExp(`${chinesePattern}${numberUnit}${terminalNoun}`));
    if (chineseBefore) {
      return normalizeRepeat(parseChineseInteger(chineseBefore[1]), MAX_SHELL_REPEAT);
    }

    const chineseAfter = normalized.match(new RegExp(`${terminalNoun}${chinesePattern}(?:个|台|扇|页|窗口)?`));
    if (chineseAfter) {
      return normalizeRepeat(parseChineseInteger(chineseAfter[1]), MAX_SHELL_REPEAT);
    }

    return 1;
  }

  async matchLinkBookmark(text, config) {
    if (!this.linkBookmarkManager) return null;
    const looksLikeOpenRequest = this.looksLikeOpenLinkRequest(text);

    const ruleMatch = this.linkBookmarkManager.matchBookmark(text);
    if (ruleMatch?.routeType === "ask" && looksLikeOpenRequest) {
      return ruleMatch;
    }
    if (ruleMatch?.bookmark) {
      const strongRuleMatch = ruleMatch.source === "link_exact" || ruleMatch.confidence >= 0.92;
      if (looksLikeOpenRequest || strongRuleMatch) {
        return this.buildLinkBookmarkMatch(ruleMatch.bookmark, ruleMatch.confidence, ruleMatch.source);
      }
    }

    if (!looksLikeOpenRequest) return null;

    const modelMatch = await this.matchLinkBookmarkWithModel(text, config);
    if (modelMatch) return modelMatch;
    return null;
  }

  looksLikeOpenLinkRequest(text) {
    const normalized = normalizePhrase(text);
    return /(打开|开启|访问|进入|看看|看一下|跳到|去到|转到|开一下|打开一下)/.test(normalized);
  }

  looksLikeExplicitTerminalOpenRequest(text) {
    const normalized = normalizePhrase(text);
    if (!normalized) return false;
    return /(打开|启动|新建|起|开|创建).*(终端|命令行|terminal|console|shell)/.test(normalized);
  }

  buildLinkBookmarkMatch(bookmark, confidence, source) {
    return {
      routeType: "intent",
      confidence,
      source,
      intent: {
        id: "open_link_bookmark",
        description: `打开${bookmark.title}`,
        allowModelFallback: false,
        action: {
          type: "open_link_bookmark",
          bookmarkId: bookmark.id,
          title: bookmark.title,
          url: bookmark.url
        }
      }
    };
  }

  async matchLinkBookmarkWithModel(text, config) {
    if (!this.qwenRouter?.chatCompletion || !this.linkBookmarkManager?.getModelCandidates) {
      return null;
    }
    const candidates = this.linkBookmarkManager.getModelCandidates();
    if (!candidates.length) return null;

    const response = await this.qwenRouter.chatCompletion(
      [
        {
          role: "system",
          content:
            "你是 CapsWriter 的链接选择器。只能从候选链接 id 中选择。只输出 JSON；不确定时 bookmarkId 必须为 null。"
        },
        {
          role: "user",
          content: JSON.stringify({
            spoken_text: text,
            candidates,
            output_schema: {
              bookmarkId: "string|null",
              confidence: "number",
              reason: "string"
            },
            confidence_threshold: config.defaults.confidenceThreshold
          }) + "\n/no_think"
        }
      ],
      {
        temperature: 0,
        max_tokens: 96,
        timeoutMs: Number(process.env.CAPSWRITER_LINK_ROUTE_QWEN_TIMEOUT_MS || 2500),
        response_format: { type: "json_object" }
      }
    );

    if (!response.success) {
      this.logWarn("Voice link model match failed", response.error || response);
      return null;
    }

    try {
      const decision = JSON.parse(response.text);
      const confidence = normalizeNumber(decision.confidence, 0);
      if (confidence < config.defaults.confidenceThreshold || !decision.bookmarkId) {
        return null;
      }
      const bookmark = this.linkBookmarkManager.getBookmark(String(decision.bookmarkId));
      if (!bookmark || bookmark.enabled === false) return null;
      return this.buildLinkBookmarkMatch(bookmark, confidence, "link_model");
    } catch (error) {
      this.logWarn("Voice link model returned invalid JSON", response.text || error);
      return null;
    }
  }

  async matchIntentWithModel(text, config, activeWindow) {
    const candidates = config.intents
      .filter((intent) => this.isIntentAllowedForModelFallback(intent, activeWindow))
      .map((intent) => ({
        id: intent.id,
        description: intent.description,
        examples: intent.examples || [],
        actionType: intent.action?.type || ""
      }));
    if (!this.qwenRouter || candidates.length === 0) {
      return { intent: null, confidence: 0, source: "none" };
    }

    const response = await this.qwenRouter.chatCompletion(
      [
        {
          role: "system",
          content:
            "你是 CapsWriter 的语音 intent 选择器。只能从候选 id 中选择。只输出 JSON，不要解释，不要推理；" +
            "不确定时 intentId 必须为 null。"
        },
        {
          role: "user",
          content: JSON.stringify({
            spoken_text: text,
            active_window: {
              title: activeWindow.windowTitle,
              class: activeWindow.windowClass,
              isTerminal: activeWindow.isTerminal,
              isCodexTerminal: activeWindow.isCodexTerminal
            },
            candidates,
            output_schema: {
              intentId: "string|null",
              confidence: "number",
              reason: "string"
            },
            confidence_threshold: config.defaults.confidenceThreshold
          }) + "\n/no_think"
        }
      ],
      {
        temperature: 0,
        max_tokens: 96,
        timeoutMs: Number(process.env.CAPSWRITER_VOICE_ROUTE_QWEN_TIMEOUT_MS || 1200),
        response_format: { type: "json_object" }
      }
    );

    if (!response.success) {
      this.logWarn("Voice action model match failed", response.error || response);
      return { intent: null, confidence: 0, source: "model", routerError: response.error || "router failed" };
    }

    try {
      const decision = JSON.parse(response.text);
      const confidence = normalizeNumber(decision.confidence, 0);
      const intent = config.intents.find((candidate) => candidate.id === decision.intentId);
      if (!intent || confidence < config.defaults.confidenceThreshold) {
        return { routeType: "ask", intent: null, confidence, source: "model", decision, reason: UNKNOWN_VOICE_COMMAND_MESSAGE };
      }
      return { routeType: "intent", intent, confidence, source: "model", decision };
    } catch (error) {
      this.logWarn("Voice action model returned invalid JSON", response.text || error);
      return { intent: null, confidence: 0, source: "model", routerError: "invalid model JSON" };
    }
  }

  isIntentAllowedForModelFallback(intent, activeWindow) {
    if (!this.isIntentAllowedInContext(intent, activeWindow)) return false;
    const actionType = String(intent?.action?.type || "");
    const highRiskAction = ["shell", "terminal_prompt", "type_text", "key_sequence", "open_link_bookmark", "codex_terminal"].includes(actionType);
    const allowModelFallback =
      typeof intent.allowModelFallback === "boolean"
        ? intent.allowModelFallback
        : typeof intent.allow_model_fallback === "boolean"
          ? intent.allow_model_fallback
          : !highRiskAction;
    return allowModelFallback;
  }

  async matchWithTeacher(text, config, activeWindow, shortcuts, context) {
    if (!this.teacherClassifier?.classify) {
      return { routeType: "teacher_unavailable", source: "none", confidence: 0 };
    }

    const response = await this.teacherClassifier.classify({
      text,
      activeWindow: {
        title: activeWindow.windowTitle,
        class: activeWindow.windowClass,
        isTerminal: activeWindow.isTerminal,
        isCodexTerminal: activeWindow.isCodexTerminal
      },
      intents: config.intents.filter((intent) => this.isIntentAllowedInContext(intent, activeWindow)),
      shortcuts,
      context
    });
    if (!response.success) {
      this.logWarn("Voice teacher classifier failed", response.error || response);
      return {
        routeType: "teacher_unavailable",
        source: "teacher_unavailable",
        confidence: 0,
        routerError: response.error || "teacher unavailable"
      };
    }

    const decision = response.decision || {};
    if (decision.confidence < config.defaults.confidenceThreshold) {
      return {
        routeType: "ask",
        source: "teacher",
        confidence: decision.confidence || 0,
        reason: decision.reason || "Teacher 低置信",
        teacherDecision: decision
      };
    }

    if (decision.routeType === "intent") {
      const intent = config.intents.find((candidate) => candidate.id === decision.intentId);
      return {
        ...decision,
        routeType: intent ? "intent" : "ask",
        intent,
        source: "teacher",
        teacherDecision: decision,
        teacherModel: response.model,
        reason: intent ? decision.reason : "Teacher 返回了不存在的 intent"
      };
    }

    return {
      ...decision,
      source: "teacher",
      teacherDecision: decision,
      teacherModel: response.model
    };
  }

  looksLikeCodexFollowup(text, context) {
    const session = context?.codexSession;
    if (!session?.awaitingFollowup) return false;
    const compact = normalizePhrase(text)
      .replace(/帮我|麻烦|请|嗯|呃|就是|一下|吧/g, "");
    return Boolean(compact);
  }

  requiresManualConfirmation(match) {
    if (match.source !== "teacher") return false;
    if (match.confirmationRequired || match.risk === "high") return true;
    return false;
  }

  shouldOpenIntentDraftReview(match) {
    return Boolean(
      match?.source === "teacher" &&
      match.learnable &&
      (match.learnTarget === "new_intent_draft" || match.learningAction === "draft_intent")
    );
  }

  buildIntentDraftCandidate(text, match) {
    const draft = match?.draftIntentRequest || {};
    return {
      phrase: text,
      routeType: match?.routeType || "ask",
      intentId: match?.intent?.id || match?.intentId || null,
      risk: match?.risk || "medium",
      suggestedPhrases: match?.suggestedPhrases || [],
      sourceTeacherModel: match?.teacherModel || "",
      draftIntentRequest: {
        userPhrase: draft.userPhrase || text,
        desiredBehavior: draft.desiredBehavior || match?.preview || match?.reason || "",
        suggestedIntentId: draft.suggestedIntentId || "",
        suggestedDescription: draft.suggestedDescription || "",
        missingDetails: Array.isArray(draft.missingDetails) ? draft.missingDetails : []
      }
    };
  }

  buildLearningCandidate(text, match) {
    if (!match?.learnable) return null;
    if (!["shortcut", "intent_example"].includes(match.learnTarget)) return null;
    if (!["intent", "codex_terminal"].includes(match.routeType)) return null;
    return {
      phrase: text,
      routeType: match.routeType,
      intentId: match.intent?.id || match.intentId || null,
      risk: match.risk || "low",
      suggestedPhrases: match.suggestedPhrases || [],
      sourceTeacherModel: match.teacherModel || ""
    };
  }

  async launchIntentDraftReview(candidate) {
    const workDir = os.homedir();
    const prompt = this.buildIntentDraftReviewPrompt(candidate);
    const title = "CapsWriter Voice Intent Review";

    if (this.commandExists("ptyxis")) {
      await this.spawnDetached("ptyxis", [
        "--new-window",
        "--working-directory",
        workDir,
        "--title",
        title,
        "--",
        "codex",
        "--cd",
        workDir,
        prompt
      ], workDir);
      return;
    }

    if (this.commandExists("gnome-terminal")) {
      await this.spawnDetached("gnome-terminal", [
        "--title",
        title,
        "--working-directory",
        workDir,
        "--",
        "codex",
        "--cd",
        workDir,
        prompt
      ], workDir);
      return;
    }

    if (this.commandExists("capswriter-add-voice-intent")) {
      await this.spawnDetached("capswriter-add-voice-intent", [], workDir);
      return;
    }

    throw new Error("未找到可用终端来审阅新语音意图");
  }

  buildIntentDraftReviewPrompt(candidate) {
    const draft = candidate?.draftIntentRequest || {};
    return [
      "用 capswriter-voice-intents skill 帮我新增一个 CapsWriter 语音意图。",
      "这是一次多轮审阅流程：先展示你理解的草案，不要直接写文件；如果信息不足，只问最关键的问题。",
      "用户明确说“确认写入”或等价确认后，才修改 voice-actions.json，并运行 validate_voice_actions.py 校验。",
      "写入 intent 成功后，把原始说法也沉淀为快捷话术：更新 ~/.config/speech-transcription/voice-route-shortcuts.json，routeType=intent，intentId=新 intent id。",
      "不要删除或重排已有 intents；只追加或按用户确认更新一个相关 intent。",
      "",
      JSON.stringify({
        original_phrase: candidate?.phrase || "",
        suggested_phrases: candidate?.suggestedPhrases || [],
        risk: candidate?.risk || "medium",
        voice_actions_path: this.configPath,
        shortcuts_path: process.env.CAPSWRITER_VOICE_SHORTCUTS_PATH || DEFAULT_SHORTCUTS_PATH,
        draft_intent_request: {
          userPhrase: draft.userPhrase || candidate?.phrase || "",
          desiredBehavior: draft.desiredBehavior || "",
          suggestedIntentId: draft.suggestedIntentId || "",
          suggestedDescription: draft.suggestedDescription || "",
          missingDetails: draft.missingDetails || []
        }
      }, null, 2)
    ].join("\n");
  }

  isIntentAllowedInContext(intent, activeWindow) {
    const context = intent?.context || {};
    if (context.requireActiveTerminal && !this.canTreatAsActiveTerminal(activeWindow)) {
      return false;
    }
    return true;
  }

  shouldDictateToTerminal(config, activeWindow) {
    return (
      config.defaults.terminalCapsMode === "dictation" &&
      activeWindow.isTerminal &&
      config.defaults.fallbackAction === "codex_terminal"
    );
  }

  async executeIntent(intent, context) {
    const action = intent.action || {};
    if (this.isRoutingCancelled(context.cancelGeneration)) {
      return this.cancelledResult(intent, context);
    }
    this.activeActionCount += 1;
    try {
      if (action.type === "shell") {
        return await this.executeShellIntent(intent, context);
      }
      if (action.type === "type_text") {
        return await this.executeTypeTextIntent(intent, context);
      }
      if (action.type === "terminal_prompt") {
        return await this.executeTerminalPromptIntent(intent, context);
      }
      if (action.type === "key_sequence") {
        return await this.executeKeySequenceIntent(intent, context);
      }
      if (action.type === "open_link_bookmark") {
        return await this.executeOpenLinkBookmarkIntent(intent, context);
      }
      if (action.type === "translate_clipboard") {
        return await this.executeTranslateClipboardIntent(intent, context);
      }
      if (action.type === "capture_hotwords") {
        return this.successResult(intent, context, "capture_hotwords", "已学习剪贴板热词");
      }
      if (action.type === "open_intent_review") {
        const candidate = this.buildIntentDraftCandidate(context.text, {
          routeType: "ask",
          risk: "medium",
          source: context.match.source,
          preview: "新增语音意图",
          draftIntentRequest: {
            userPhrase: context.text,
            desiredBehavior: "新增或调整一个 CapsWriter 预设语音指令",
            suggestedIntentId: "",
            suggestedDescription: "",
            missingDetails: []
          }
        });
        this.learningManager.recordIntentDraft(candidate);
        await this.launchIntentDraftReview(candidate);
        return this.successResult(intent, context, "open_intent_review", "已打开新语音意图审阅终端");
      }
      if (action.type === "dictation") {
        await this.pasteToActiveWindow(context.text, context.activeWindow.windowId);
        return this.successResult(intent, context, "dictation", "已按普通听写粘贴");
      }
      if (action.type === "codex_terminal") {
        return { handled: false, success: true, fallback: "codex_terminal" };
      }
      return { handled: true, success: false, error: `Unsupported action type: ${action.type}` };
    } catch (error) {
      const message = error?.message || String(error);
      this.logWarn("Voice action execution failed", { intentId: intent.id, error: message });
      return {
        handled: true,
        success: false,
        handledByVoiceAction: true,
        intentId: intent.id,
        actionType: action.type,
        error: message
      };
    } finally {
      this.activeActionCount = Math.max(0, this.activeActionCount - 1);
    }
  }

  cancelledResult(intent, context = {}) {
    return {
      handled: true,
      success: false,
      handledByVoiceAction: true,
      intentId: intent?.id || context.match?.intent?.id || "",
      actionType: intent?.action?.type || context.match?.intent?.action?.type || "cancelled",
      cancelled: true,
      error: "语音指令已取消",
      activeWindow: context.activeWindow || null
    };
  }

  async executeShellIntent(intent, context) {
    const action = intent.action;
    const cwd = this.resolveActionCwd(action, context.activeWindow);
    const command = String(action.command || "").trim();
    if (!command) {
      throw new Error("shell action 缺少 command");
    }
    const args = (Array.isArray(action.args) ? action.args : []).map((arg) =>
      this.resolvePlaceholder(arg, context.activeWindow, cwd)
    );
    const repeat = this.normalizeShellRepeat(
      action.repeat || (
        intent.id === "open_gnome_terminal"
          ? this.extractTerminalOpenRepeat(context.text)
          : 1
      )
    );

    for (let index = 0; index < repeat; index += 1) {
      if (this.isRoutingCancelled(context.cancelGeneration)) {
        return this.cancelledResult(intent, context);
      }
      await this.spawnDetached(command, args, cwd);
    }
    const message = repeat > 1
      ? `已执行 ${repeat} 次：${intent.description || intent.id}`
      : `已执行：${intent.description || intent.id}`;
    return this.successResult(intent, context, "shell", message);
  }

  normalizeShellRepeat(value) {
    return normalizeRepeat(value, MAX_SHELL_REPEAT);
  }

  async executeTypeTextIntent(intent, context) {
    const action = intent.action;
    await this.pasteToActiveWindow(action.text || "", context.activeWindow.windowId);
    if (action.submit === "enter") {
      await this.pressEnter(context.activeWindow.windowId);
    }
    return this.successResult(intent, context, "type_text", `已输入：${action.text || intent.id}`);
  }

  async executeTerminalPromptIntent(intent, context) {
    const action = intent.action;
    if (!context.activeWindow.windowId) {
      throw new Error("请先激活目标终端");
    }
    if (!this.canTreatAsActiveTerminal(context.activeWindow)) {
      throw new Error("当前活动窗口不是终端");
    }
    if (action.openTab) {
      await this.openTerminalTab(context.activeWindow.windowId);
    }
    await this.pasteToActiveWindow(action.prompt || "", context.activeWindow.windowId);
    await this.pressEnter(context.activeWindow.windowId);
    return this.successResult(intent, context, "terminal_prompt", "已发送到当前终端");
  }

  async executeKeySequenceIntent(intent, context) {
    if (process.platform !== "linux") {
      throw new Error("key_sequence action 仅支持 Linux");
    }
    const action = intent.action || {};
    const ydotoolKeys = Array.isArray(action.ydotoolKeys) ? action.ydotoolKeys : [];
    const xdotoolKeys = Array.isArray(action.xdotoolKeys) ? action.xdotoolKeys : [];
    if (ydotoolKeys.length === 0 && xdotoolKeys.length === 0) {
      throw new Error("key_sequence action 缺少按键序列");
    }
    const repeat = this.normalizeKeySequenceRepeat(
      action.repeat || (
        /^move_window_to_(left|right)_workspace$/.test(intent.id)
          ? this.extractWorkspaceMoveRepeat(context.text)
          : 1
      )
    );
    if (context.activeWindow.windowId) {
      await this.runCommand("xdotool", ["windowactivate", "--sync", String(context.activeWindow.windowId)], 2000);
      await sleep(ENTER_KEY_SETTLE_MS);
    }
    for (let index = 0; index < repeat; index += 1) {
      if (this.isRoutingCancelled(context.cancelGeneration)) {
        return this.cancelledResult(intent, context);
      }
      await this.runLinuxKeySequence({
        ydotoolKeys,
        xdotoolKeys,
        timeoutMs: action.timeoutMs || 1500
      });
    }
    return this.successResult(intent, context, "key_sequence", `已执行：${intent.description || intent.id}`);
  }

  async executeOpenLinkBookmarkIntent(intent, context) {
    const action = intent.action || {};
    const bookmark = action.bookmarkId && this.linkBookmarkManager?.getBookmark
      ? this.linkBookmarkManager.getBookmark(action.bookmarkId)
      : null;
    const url = String(bookmark?.url || action.url || "").trim();
    if (!isHttpUrl(url)) {
      throw new Error("只支持 http/https 链接");
    }
    if (bookmark?.enabled === false) {
      throw new Error("链接已禁用");
    }
    if (!this.openExternal) {
      throw new Error("openExternal unavailable");
    }
    if (this.isRoutingCancelled(context.cancelGeneration)) {
      return this.cancelledResult(intent, context);
    }
    await this.openExternal(url);
    return this.successResult(
      intent,
      context,
      "open_link_bookmark",
      `已打开：${bookmark?.title || action.title || url}`
    );
  }

  async executeTranslateClipboardIntent(intent, context) {
    const action = intent.action || {};
    if (!this.clipboardManager?.readClipboard) {
      throw new Error("clipboardManager unavailable");
    }
    if (!this.qwenRouter?.chatCompletion) {
      throw new Error("翻译路由不可用");
    }

    const sourceText = String(await this.clipboardManager.readClipboard() || "").trim();
    if (!sourceText) {
      throw new Error("剪贴板没有可翻译的文本");
    }

    const target = this.resolveTranslateTarget(action.translateTarget || action.targetLanguage || "zh");
    const response = await this.qwenRouter.chatCompletion(
      this.buildTranslateClipboardMessages(sourceText, target),
      {
        temperature: 0,
        max_tokens: action.maxTokens || 2048
      }
    );

    if (!response.success) {
      throw new Error(response.error || "剪贴板翻译失败");
    }

    const translatedText = this.cleanTranslatedText(response.text);
    if (!translatedText) {
      throw new Error("翻译结果为空");
    }

    await this.pasteToActiveWindow(translatedText, context.activeWindow.windowId);
    return this.successResult(intent, context, "translate_clipboard", "已翻译剪贴板并粘贴");
  }

  resolveTranslateTarget(target) {
    const normalized = String(target || "zh").trim().toLowerCase();
    if (["zh", "zh-cn", "chinese", "中文", "简体中文"].includes(normalized)) {
      return "简体中文";
    }
    if (["en", "english", "英文"].includes(normalized)) {
      return "英文";
    }
    return normalized || "简体中文";
  }

  buildTranslateClipboardMessages(sourceText, target) {
    return [
      {
        role: "system",
        content: "你是机器翻译引擎。只输出译文，不要解释、不要加引号、不要使用 Markdown。"
      },
      {
        role: "user",
        content: `请将下面文本翻译成${target}：\n\n${sourceText}`
      }
    ];
  }

  cleanTranslatedText(value) {
    return String(value || "")
      .trim()
      .replace(/^```(?:\w+)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  successResult(intent, context, actionType, message) {
    return {
      handled: true,
      success: true,
      handledByVoiceAction: true,
      intentId: intent.id,
      actionType,
      confidence: context.match.confidence,
      matchSource: context.match.source,
      message,
      activeWindow: context.activeWindow,
      learningCandidate: this.buildLearningCandidate(context.text, context.match)
    };
  }

  resolveActionCwd(action, activeWindow) {
    if (action.cwd === "active_terminal_or_process_cwd") {
      return activeWindow.cwd || process.cwd();
    }
    if (action.cwd) {
      return path.resolve(expandHome(action.cwd));
    }
    return activeWindow.cwd || process.cwd();
  }

  resolvePlaceholder(value, activeWindow, cwd) {
    if (value === "$PWD") {
      return activeWindow.cwd || cwd || process.cwd();
    }
    return String(value);
  }

  async pasteToActiveWindow(text, windowId) {
    if (!this.clipboardManager?.pasteText) {
      throw new Error("clipboardManager unavailable");
    }
    const previousTargetWindowId = this.clipboardManager.targetWindowId || null;
    if (windowId && this.clipboardManager.setTargetWindow) {
      this.clipboardManager.setTargetWindow(windowId);
    }
    try {
      return await this.clipboardManager.pasteText(String(text || ""));
    } finally {
      if (this.clipboardManager.setTargetWindow) {
        this.clipboardManager.setTargetWindow(previousTargetWindowId);
      }
    }
  }

  async pressEnter(windowId) {
    if (process.platform !== "linux") return;
    if (!windowId) {
      throw new Error("缺少活动窗口，无法发送回车");
    }
    await this.runCommand("xdotool", ["windowactivate", "--sync", String(windowId)], 2000);
    await sleep(ENTER_KEY_SETTLE_MS);
    await this.runLinuxKeySequence({
      ydotoolKeys: ["28:1", "28:0"],
      xdotoolKeys: ["Return"],
      timeoutMs: 1500
    });
  }

  async openTerminalTab(windowId) {
    if (process.platform !== "linux") return;
    if (!windowId) {
      throw new Error("缺少活动窗口，无法新建终端标签页");
    }
    await this.runCommand("xdotool", ["windowactivate", "--sync", String(windowId)], 2000);
    await sleep(ENTER_KEY_SETTLE_MS);
    await this.runLinuxKeySequence({
      ydotoolKeys: ["29:1", "42:1", "20:1", "20:0", "42:0", "29:0"],
      xdotoolKeys: ["ctrl+shift+t"],
      timeoutMs: 1800
    });
    await sleep(TERMINAL_TAB_SETTLE_MS);
  }

  async runLinuxKeySequence({ ydotoolKeys = [], xdotoolKeys = [], timeoutMs = 1500 } = {}) {
    if (ydotoolKeys.length > 0) {
      try {
        await this.runCommand("ydotool", ["key", "--key-delay", "25", ...ydotoolKeys], timeoutMs);
        return;
      } catch (error) {
        this.logWarn("ydotool key sequence failed, falling back to xdotool", error?.message || error);
      }
    }
    if (xdotoolKeys.length > 0) {
      await this.runCommand("xdotool", ["key", "--delay", "35", ...xdotoolKeys], timeoutMs);
    }
  }

  spawnDetached(command, args, cwd) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd,
          detached: true,
          stdio: "ignore",
          env: process.env
        });
      } catch (error) {
        reject(error);
        return;
      }

      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  commandExists(command) {
    try {
      execFileSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 1000
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  runCommand(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} timed out`));
      }, timeoutMs);

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `${command} exited with ${code}`));
        }
      });
    });
  }

  getActiveWindowInfo(windowId) {
    const resolvedWindowId = String(windowId || this.getCurrentActiveWindowId() || "").trim();
    const meta = this.clipboardManager?.getLinuxWindowMeta
      ? this.clipboardManager.getLinuxWindowMeta(resolvedWindowId)
      : { windowId: resolvedWindowId, windowClass: "", windowTitle: "" };
    const pid = this.getWindowPid(resolvedWindowId);
    const cwd = this.getProcessCwd(pid);
    return {
      windowId: resolvedWindowId,
      windowClass: meta.windowClass || "",
      windowTitle: meta.windowTitle || "",
      pid,
      cwd,
      isTerminal: this.isTerminalWindow(meta.windowClass, meta.windowTitle),
      isUnknownWindow: Boolean(resolvedWindowId && !meta.windowClass && !meta.windowTitle)
    };
  }

  getCurrentActiveWindowId() {
    if (process.platform !== "linux") return "";
    try {
      return execFileSync("xdotool", ["getactivewindow"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch (_) {
      return "";
    }
  }

  getWindowPid(windowId) {
    if (!windowId || process.platform !== "linux") return "";
    try {
      return execFileSync("xdotool", ["getwindowpid", String(windowId)], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch (_) {
      return "";
    }
  }

  getProcessCwd(pid) {
    if (!pid || process.platform !== "linux") return "";
    try {
      return fs.realpathSync(`/proc/${pid}/cwd`);
    } catch (_) {
      return "";
    }
  }

  isTerminalWindow(windowClass, windowTitle) {
    const normalizedClass = String(windowClass || "").toLowerCase();
    const normalizedTitle = String(windowTitle || "").toLowerCase();
    return (
      /(gnome-terminal|ptyxis|konsole|xterm|alacritty|kitty|wezterm|terminator|tilix)/.test(normalizedClass) ||
      /(terminal|shell|bash|zsh|fish)/.test(normalizedTitle)
    );
  }

  canTreatAsActiveTerminal(activeWindow) {
    return Boolean(activeWindow?.isTerminal || activeWindow?.isUnknownWindow);
  }

  logWarn(message, payload) {
    if (this.logger?.warn) {
      this.logger.warn(message, payload);
    }
  }
}

module.exports = VoiceActionManager;
