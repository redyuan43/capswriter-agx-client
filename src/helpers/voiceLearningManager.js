const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_SHORTCUTS_PATH = path.join(
  os.homedir(),
  ".config",
  "speech-transcription",
  "voice-route-shortcuts.json"
);
const DEFAULT_LEARNING_QUEUE_PATH = path.join(
  os.homedir(),
  ".config",
  "speech-transcription",
  "voice-learning-queue.json"
);

function expandHome(value) {
  return String(value || "").replace(/^~(?=$|\/)/, os.homedir());
}

function normalizePhrase(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:"“”'‘’（）()\[\]{}<>《》\s]/g, "")
    .replace(/剪切板/g, "剪贴板")
    .replace(/命令行窗口/g, "命令行")
    .replace(/终端窗口/g, "终端")
    .replace(/深圳市/g, "深圳");
}

function uniqueStrings(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = normalizePhrase(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

class VoiceLearningManager {
  constructor({ logger = null, shortcutsPath = "", queuePath = "" } = {}) {
    this.logger = logger;
    this.shortcutsPath = expandHome(
      shortcutsPath || process.env.CAPSWRITER_VOICE_SHORTCUTS_PATH || DEFAULT_SHORTCUTS_PATH
    );
    this.queuePath = expandHome(
      queuePath || process.env.CAPSWRITER_VOICE_LEARNING_QUEUE_PATH || DEFAULT_LEARNING_QUEUE_PATH
    );
  }

  loadShortcuts() {
    try {
      const data = JSON.parse(fs.readFileSync(this.shortcutsPath, "utf8"));
      const shortcuts = Array.isArray(data?.shortcuts) ? data.shortcuts : [];
      return shortcuts.filter((shortcut) => shortcut && shortcut.enabled !== false);
    } catch (_) {
      return [];
    }
  }

  learnShortcut(candidate) {
    const phrase = String(candidate?.phrase || "").trim();
    const routeType = String(candidate?.routeType || "").trim();
    const intentId = candidate?.intentId ? String(candidate.intentId).trim() : null;
    const normalizedPhrase = normalizePhrase(phrase);

    if (!phrase || !normalizedPhrase) {
      return { success: false, error: "缺少可学习的话术" };
    }
    if (!["intent", "codex_terminal"].includes(routeType)) {
      return { success: false, error: "不支持的学习类型" };
    }
    if (routeType === "intent" && !intentId) {
      return { success: false, error: "intent 学习缺少 intentId" };
    }

    const data = this.loadRawShortcuts();
    const now = new Date().toISOString();
    const existing = data.shortcuts.find((shortcut) =>
      (shortcut.normalizedPhrases || [shortcut.normalizedPhrase]).includes(normalizedPhrase)
    );

    if (existing) {
      existing.phrases = uniqueStrings([...(existing.phrases || []), phrase, ...(candidate.suggestedPhrases || [])]);
      existing.normalizedPhrases = uniqueStrings(existing.phrases).map(normalizePhrase);
      existing.routeType = routeType;
      existing.intentId = intentId;
      existing.risk = candidate.risk || existing.risk || "low";
      existing.lastUpdatedAt = now;
      existing.enabled = true;
      this.writeRawShortcuts(data);
      this.recordLearningEvent("shortcut_updated", {
        phrase,
        routeType,
        intentId,
        shortcutId: existing.id,
        risk: existing.risk
      });
      return { success: true, shortcut: existing, updated: true };
    }

    const phrases = uniqueStrings([phrase, ...(candidate.suggestedPhrases || [])]);
    const shortcut = {
      id: `shortcut_${Date.now().toString(36)}`,
      phrase,
      phrases,
      normalizedPhrase,
      normalizedPhrases: phrases.map(normalizePhrase),
      routeType,
      intentId,
      risk: candidate.risk || "low",
      createdAt: now,
      lastUsedAt: "",
      useCount: 0,
      sourceTeacherModel: candidate.sourceTeacherModel || "",
      enabled: true
    };
    data.shortcuts.push(shortcut);
    this.writeRawShortcuts(data);
    this.recordLearningEvent("shortcut_created", {
      phrase,
      routeType,
      intentId,
      shortcutId: shortcut.id,
      risk: shortcut.risk,
      sourceTeacherModel: shortcut.sourceTeacherModel
    });
    return { success: true, shortcut, updated: false };
  }

  recordTeacherDecision({ phrase, match, activeWindow = null, context = null } = {}) {
    if (!match || match.source !== "teacher") return;
    this.recordLearningEvent("teacher_decision", {
      phrase: String(phrase || "").trim(),
      normalizedPhrase: normalizePhrase(phrase),
      routeType: match.routeType || "",
      intentId: match.intent?.id || match.intentId || null,
      confidence: match.confidence || 0,
      risk: match.risk || "low",
      learnable: Boolean(match.learnable),
      learnTarget: match.learnTarget || "none",
      learningAction: match.learningAction || "none",
      suggestedPhrases: match.suggestedPhrases || [],
      reason: match.reason || "",
      preview: match.preview || "",
      teacherModel: match.teacherModel || "",
      activeWindow: this.compactActiveWindow(activeWindow),
      codexSession: context?.codexSession || null
    });
  }

  recordIntentDraft(candidate) {
    this.recordLearningEvent("intent_draft_requested", {
      phrase: String(candidate?.phrase || "").trim(),
      normalizedPhrase: normalizePhrase(candidate?.phrase),
      routeType: candidate?.routeType || "ask",
      intentId: candidate?.intentId || null,
      risk: candidate?.risk || "medium",
      suggestedPhrases: candidate?.suggestedPhrases || [],
      draftIntentRequest: candidate?.draftIntentRequest || {},
      sourceTeacherModel: candidate?.sourceTeacherModel || ""
    });
  }

  markUsed(shortcutId) {
    if (!shortcutId) return;
    try {
      const data = this.loadRawShortcuts();
      const shortcut = data.shortcuts.find((item) => item.id === shortcutId);
      if (!shortcut) return;
      shortcut.lastUsedAt = new Date().toISOString();
      shortcut.useCount = Number(shortcut.useCount || 0) + 1;
      this.writeRawShortcuts(data);
    } catch (error) {
      this.logWarn("Failed to mark voice shortcut used", error?.message || error);
    }
  }

  loadRawShortcuts() {
    try {
      const data = JSON.parse(fs.readFileSync(this.shortcutsPath, "utf8"));
      return {
        version: data?.version || 1,
        shortcuts: Array.isArray(data?.shortcuts) ? data.shortcuts : []
      };
    } catch (_) {
      return { version: 1, shortcuts: [] };
    }
  }

  loadRawQueue() {
    try {
      const data = JSON.parse(fs.readFileSync(this.queuePath, "utf8"));
      return {
        version: data?.version || 1,
        events: Array.isArray(data?.events) ? data.events : []
      };
    } catch (_) {
      return { version: 1, events: [] };
    }
  }

  writeRawQueue(data) {
    fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
    fs.writeFileSync(
      this.queuePath,
      `${JSON.stringify({ version: 1, events: data.events || [] }, null, 2)}\n`,
      "utf8"
    );
  }

  recordLearningEvent(type, payload = {}) {
    try {
      const data = this.loadRawQueue();
      data.events.push({
        id: `learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        createdAt: new Date().toISOString(),
        ...payload
      });
      data.events = data.events.slice(-300);
      this.writeRawQueue(data);
    } catch (error) {
      this.logWarn("Failed to record voice learning event", error?.message || error);
    }
  }

  compactActiveWindow(activeWindow) {
    if (!activeWindow) return null;
    return {
      windowClass: activeWindow.windowClass || "",
      windowTitle: activeWindow.windowTitle || "",
      isTerminal: Boolean(activeWindow.isTerminal),
      isCodexTerminal: Boolean(activeWindow.isCodexTerminal)
    };
  }

  writeRawShortcuts(data) {
    fs.mkdirSync(path.dirname(this.shortcutsPath), { recursive: true });
    fs.writeFileSync(
      this.shortcutsPath,
      `${JSON.stringify({ version: 1, shortcuts: data.shortcuts || [] }, null, 2)}\n`,
      "utf8"
    );
  }

  logWarn(message, payload) {
    if (this.logger?.warn) {
      this.logger.warn(message, payload);
    }
  }
}

module.exports = {
  VoiceLearningManager,
  DEFAULT_SHORTCUTS_PATH,
  DEFAULT_LEARNING_QUEUE_PATH,
  normalizePhrase
};
