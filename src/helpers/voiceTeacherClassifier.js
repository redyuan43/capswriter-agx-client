const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_TEACHER_MODEL = "gpt-5.5";
const DEFAULT_TEACHER_TIMEOUT_MS = 45000;

const TEACHER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    routeType: { type: "string", enum: ["intent", "codex_terminal", "ask"] },
    intentId: { anyOf: [{ type: "string" }, { type: "null" }] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    confirmationRequired: { type: "boolean" },
    learnable: { type: "boolean" },
    learnTarget: { type: "string", enum: ["shortcut", "intent_example", "new_intent_draft", "none"] },
    learningAction: { type: "string", enum: ["none", "learn_shortcut", "draft_intent", "promote_rule"] },
    targetRoute: { type: "string", enum: ["intent", "codex_terminal", "ask"] },
    suggestedPhrases: {
      type: "array",
      items: { type: "string" },
      maxItems: 5
    },
    draftIntentRequest: {
      type: "object",
      additionalProperties: false,
      properties: {
        userPhrase: { type: "string" },
        desiredBehavior: { type: "string" },
        suggestedIntentId: { type: "string" },
        suggestedDescription: { type: "string" },
        missingDetails: {
          type: "array",
          items: { type: "string" },
          maxItems: 5
        }
      },
      required: [
        "userPhrase",
        "desiredBehavior",
        "suggestedIntentId",
        "suggestedDescription",
        "missingDetails"
      ]
    },
    preview: { type: "string" },
    reason: { type: "string" }
  },
  required: [
    "routeType",
    "intentId",
    "confidence",
    "risk",
    "confirmationRequired",
    "learnable",
    "learnTarget",
    "learningAction",
    "targetRoute",
    "suggestedPhrases",
    "draftIntentRequest",
    "preview",
    "reason"
  ]
};

function enabledByEnv(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty teacher response");
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("teacher response is not JSON");
    return JSON.parse(match[0]);
  }
}

function emptyDraftIntentRequest() {
  return {
    userPhrase: "",
    desiredBehavior: "",
    suggestedIntentId: "",
    suggestedDescription: "",
    missingDetails: []
  };
}

function normalizeDraftIntentRequest(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    userPhrase: String(source.userPhrase || "").trim(),
    desiredBehavior: String(source.desiredBehavior || "").trim(),
    suggestedIntentId: String(source.suggestedIntentId || "").trim(),
    suggestedDescription: String(source.suggestedDescription || "").trim(),
    missingDetails: Array.isArray(source.missingDetails)
      ? source.missingDetails.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
      : []
  };
}

function inferLearningAction(decision) {
  if (decision?.learnTarget === "new_intent_draft") return "draft_intent";
  if (decision?.learnable && ["shortcut", "intent_example"].includes(decision.learnTarget)) {
    return "learn_shortcut";
  }
  return "none";
}

class VoiceTeacherClassifier {
  constructor({ logger = null, cwd = process.cwd() } = {}) {
    this.logger = logger;
    this.cwd = cwd;
    this.enabled = enabledByEnv(process.env.CAPSWRITER_VOICE_TEACHER_ENABLED, true);
    this.model = process.env.CAPSWRITER_VOICE_TEACHER_MODEL || DEFAULT_TEACHER_MODEL;
    this.timeoutMs = normalizeNumber(
      process.env.CAPSWRITER_VOICE_TEACHER_TIMEOUT_MS,
      DEFAULT_TEACHER_TIMEOUT_MS
    );
    this.activeChild = null;
  }

  cancelActive(reason = "cancelled") {
    if (!this.activeChild) return false;
    try {
      this.activeChild.kill("SIGKILL");
      this.logInfo("Voice teacher classifier cancelled", { reason });
      return true;
    } catch (error) {
      this.logWarn("Failed to cancel voice teacher classifier", error?.message || error);
      return false;
    }
  }

  async classify({ text, activeWindow = null, intents = [], shortcuts = [], context = {} } = {}) {
    if (!this.enabled) {
      return { success: false, error: "teacher disabled" };
    }

    const prompt = this.buildPrompt({ text, activeWindow, intents, shortcuts, context });
    const schemaPath = this.writeTempSchema();
    const outputPath = path.join(os.tmpdir(), `capswriter-teacher-output-${process.pid}-${Date.now()}.json`);

    try {
      const result = await this.runCodexExec(prompt, schemaPath, outputPath);
      if (!result.success) return result;
      const parsed = safeJsonParse(result.text);
      return {
        success: true,
        decision: this.normalizeDecision(parsed, intents),
        rawText: result.text,
        model: this.model
      };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    } finally {
      [schemaPath, outputPath].forEach((filePath) => {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {
          // best effort cleanup
        }
      });
    }
  }

  buildPrompt({ text, activeWindow, intents, shortcuts, context }) {
    const candidates = intents.map((intent) => ({
      id: intent.id,
      description: intent.description || "",
      examples: intent.examples || [],
      actionType: intent.action?.type || "",
      context: intent.context || {}
    }));
    const learnedShortcuts = shortcuts.map((shortcut) => ({
      id: shortcut.id,
      phrases: shortcut.phrases || (shortcut.phrase ? [shortcut.phrase] : []),
      routeType: shortcut.routeType,
      intentId: shortcut.intentId || null
    }));

    return [
      "你是 CapsWriter 的 Teacher Classifier，只做语音路由分类，不执行工具、不改文件。",
      "只能根据输入 JSON 输出符合 schema 的 JSON，不要解释，不要 Markdown。",
      "routeType 只能是 intent、codex_terminal、ask。",
      "intent 只能选择候选 intent id；不确定、指代不清、缺少上下文时选择 ask。",
      "开放查询、写作、分析、排障、需要 Codex 处理的任务选择 codex_terminal。",
      "天气、下雨、带伞、查询资料这类请求即使缺少城市或条件，也选择 codex_terminal，让 Codex 后续追问。",
      "整理刚才讨论的方案、总结刚才内容、写测试计划这类工作流请求选择 codex_terminal，不要因为出现“刚才”就 ask。",
      "如果 codex_session.awaitingFollowup=true，且没有命中固定 intent，则用户的自然语言回复选择 codex_terminal，继续交给同一个 Codex Terminal。",
      "如果 active_window.isTerminal=true，且用户要总结终端、概括终端、看看终端卡在哪里，优先选择 summarize_current_terminal intent。",
      "单个城市名、地点名、短名词只有在 codex_session.awaitingFollowup=true 时才可视为续聊，否则 ask。",
      "learnable 只在这句话适合下次确定性复用时为 true；追问补充词、代词、含糊话术必须 false。",
      "如果用户表达“以后我说 X 就帮我 Y”“创建/新增一个目前不存在的语音能力”，且候选 intent 无法满足，则 routeType=ask，learnable=true，learnTarget=new_intent_draft，learningAction=draft_intent。",
      "new_intent_draft 只生成意图草案请求，不执行工具、不改文件；draftIntentRequest 要概括用户想说什么、想做什么、缺什么信息。",
      "已有 intent 的不同说法可 learningAction=learn_shortcut；开放但高频的 Codex 任务可学习为 codex_terminal shortcut。",
      "候选 intent 是已经配置好的固定动作；打开终端、翻译剪贴板、总结终端、打开 VS Code 这类固定动作可标 low 或 medium。",
      "删除/移动文件、提交代码、系统设置、发送消息、未知 shell、新建危险动作草案必须标 high 并要求确认。",
      "",
      JSON.stringify({
        spoken_text: String(text || "").trim(),
        active_window: activeWindow,
        compact_context: {
          recent_utterances: context?.recentUtterances || [],
          codex_session: context?.codexSession || null,
          pending_voice_question: context?.pendingVoiceQuestion || null
        },
        learned_shortcuts: learnedShortcuts,
        intent_candidates: candidates
      })
    ].join("\n");
  }

  writeTempSchema() {
    const schemaPath = path.join(os.tmpdir(), `capswriter-teacher-schema-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(schemaPath, JSON.stringify(TEACHER_OUTPUT_SCHEMA), "utf8");
    return schemaPath;
  }

  runCodexExec(prompt, schemaPath, outputPath) {
    return new Promise((resolve) => {
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-rules",
        "-c",
        "model_reasoning_effort=\"low\"",
        "--model",
        this.model,
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--",
        prompt
      ];
      const child = spawn("codex", args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.activeChild = child;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.timeoutMs);

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = null;
        resolve({ success: false, error: error?.message || String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (this.activeChild === child) this.activeChild = null;
        let outputText = "";
        try {
          outputText = fs.readFileSync(outputPath, "utf8");
        } catch (_) {
          outputText = stdout;
        }
        if (code === 0 && outputText.trim()) {
          resolve({ success: true, text: outputText.trim() });
          return;
        }
        resolve({
          success: false,
          error: stderr.trim() || stdout.trim() || `codex exec exited with ${code}`
        });
      });
    });
  }

  normalizeDecision(decision, intents) {
    const routeType = ["intent", "codex_terminal", "ask"].includes(decision.routeType)
      ? decision.routeType
      : "ask";
    const confidence = Math.max(0, Math.min(1, Number(decision.confidence) || 0));
    const intent = routeType === "intent"
      ? intents.find((candidate) => candidate.id === decision.intentId)
      : null;

    if (routeType === "intent" && !intent) {
      return {
        routeType: "ask",
        intentId: null,
        confidence: 0,
        risk: "low",
        confirmationRequired: false,
        learnable: false,
        learnTarget: "none",
        learningAction: "none",
        targetRoute: "ask",
        suggestedPhrases: [],
        draftIntentRequest: emptyDraftIntentRequest(),
        preview: "",
        reason: "Teacher 返回了不存在的 intent"
      };
    }

    return {
      routeType,
      intentId: intent ? intent.id : null,
      confidence,
      risk: ["low", "medium", "high"].includes(decision.risk) ? decision.risk : "low",
      confirmationRequired: Boolean(decision.confirmationRequired),
      learnable: Boolean(decision.learnable),
      learnTarget: ["shortcut", "intent_example", "new_intent_draft", "none"].includes(decision.learnTarget)
        ? decision.learnTarget
        : "none",
      learningAction: ["none", "learn_shortcut", "draft_intent", "promote_rule"].includes(decision.learningAction)
        ? decision.learningAction
        : inferLearningAction(decision),
      targetRoute: ["intent", "codex_terminal", "ask"].includes(decision.targetRoute)
        ? decision.targetRoute
        : routeType,
      suggestedPhrases: Array.isArray(decision.suggestedPhrases)
        ? decision.suggestedPhrases.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
        : [],
      draftIntentRequest: normalizeDraftIntentRequest(decision.draftIntentRequest),
      preview: String(decision.preview || "").trim(),
      reason: String(decision.reason || "").trim()
    };
  }

  logInfo(message, payload) {
    if (this.logger?.info) {
      this.logger.info(message, payload);
    }
  }

  logWarn(message, payload) {
    if (this.logger?.warn) {
      this.logger.warn(message, payload);
    }
  }
}

module.exports = {
  VoiceTeacherClassifier,
  DEFAULT_TEACHER_MODEL,
  DEFAULT_TEACHER_TIMEOUT_MS
};
