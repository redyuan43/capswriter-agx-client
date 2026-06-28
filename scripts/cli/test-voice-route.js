#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Nx1QwenRouter } = require("../../src/helpers/nx1QwenRouter");
const { VoiceTeacherClassifier } = require("../../src/helpers/voiceTeacherClassifier");
const { DEFAULT_SHORTCUTS_PATH } = require("../../src/helpers/voiceLearningManager");

const DEFAULT_SCENARIOS_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "voice-route-v2-scenarios.json"
);
const DEFAULT_CHINESE_SCENARIOS_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "voice-route-v3-chinese-random.json"
);
const DEFAULT_VOICE_ACTIONS_PATH = path.join(
  os.homedir(),
  ".config",
  "speech-transcription",
  "voice-actions.json"
);

function parseArgs(argv) {
  const args = {
    seed: 20260513,
    samplesPerScenario: null,
    scenariosPath: DEFAULT_SCENARIOS_PATH,
    voiceActionsPath: DEFAULT_VOICE_ACTIONS_PATH,
    learnedShortcutsPath: DEFAULT_SHORTCUTS_PATH,
    liveQwen: false,
    teacherCodex: false,
    randomChinese: null,
    minRate: null,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--seed") {
      args.seed = Number(argv[++index]);
    } else if (item === "--samples-per-scenario") {
      args.samplesPerScenario = Number(argv[++index]);
    } else if (item === "--scenarios") {
      args.scenariosPath = path.resolve(argv[++index]);
    } else if (item === "--voice-actions") {
      args.voiceActionsPath = path.resolve(argv[++index]);
    } else if (item === "--learned-shortcuts") {
      args.learnedShortcutsPath = path.resolve(argv[++index]);
    } else if (item === "--live-qwen") {
      args.liveQwen = true;
    } else if (item === "--teacher-codex") {
      args.teacherCodex = true;
    } else if (item === "--random-chinese") {
      args.randomChinese = Number(argv[++index]);
    } else if (item === "--min-rate") {
      args.minRate = Number(argv[++index]);
    } else if (item === "--json") {
      args.json = true;
    } else if (item === "--help" || item === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${item}`);
    }
  }

  if (!Number.isFinite(args.seed)) {
    throw new Error("--seed 必须是数字");
  }
  if (args.samplesPerScenario !== null && (!Number.isFinite(args.samplesPerScenario) || args.samplesPerScenario <= 0)) {
    throw new Error("--samples-per-scenario 必须是正数");
  }
  if (args.randomChinese !== null && (!Number.isFinite(args.randomChinese) || args.randomChinese <= 0)) {
    throw new Error("--random-chinese 必须是正数");
  }
  if (args.minRate !== null && (!Number.isFinite(args.minRate) || args.minRate < 0 || args.minRate > 1)) {
    throw new Error("--min-rate 必须是 0 到 1 之间的数字");
  }
  if (args.randomChinese !== null && args.scenariosPath === DEFAULT_SCENARIOS_PATH) {
    args.scenariosPath = DEFAULT_CHINESE_SCENARIOS_PATH;
  }
  if (args.minRate === null) {
    args.minRate = args.randomChinese !== null ? 0.95 : 1;
  }
  return args;
}

function printUsage() {
  console.log(`用法: node scripts/cli/test-voice-route.js [选项]

选项:
  --seed <number>                  固定随机种子，默认 20260513
  --samples-per-scenario <number>  每个场景生成多少条随机样本
  --scenarios <path>               场景 fixture JSON
  --voice-actions <path>           voice-actions.json 路径
  --learned-shortcuts <path>       已学习快捷话术 JSON 路径
  --live-qwen                      使用真实 Spark 服务端小模型生成路由决策
  --teacher-codex                  使用 codex exec GPT-5.5 Teacher 生成路由决策
  --random-chinese <number>        从中文场景中随机抽样总条数
  --min-rate <0..1>                最低通过率，随机中文默认 0.95，其他默认 1
  --json                           输出 JSON 汇总

示例:
  node scripts/cli/test-voice-route.js
  node scripts/cli/test-voice-route.js --seed 42 --samples-per-scenario 20
  node scripts/cli/test-voice-route.js --teacher-codex --random-chinese 20
`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function tryReadJson(filePath, fallback) {
  try {
    return readJson(filePath);
  } catch (_) {
    return fallback;
  }
}

function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items[Math.floor(random() * items.length)];
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

function stripPoliteNoise(value) {
  let text = normalizePhrase(value);
  [
    "帮我",
    "麻烦",
    "那个",
    "请",
    "嗯",
    "呃",
    "就是",
    "可以吗",
    "谢谢",
    "一下",
    "吧"
  ].forEach((token) => {
    text = text.replace(new RegExp(token, "g"), "");
  });
  return text;
}

function hasPhraseMatch(text, phrases) {
  const normalizedText = normalizePhrase(text);
  const compactText = stripPoliteNoise(text);
  return (phrases || []).some((phrase) => {
    const normalizedPhrase = normalizePhrase(phrase);
    const compactPhrase = stripPoliteNoise(phrase);
    if (!normalizedPhrase) return false;
    if (normalizedText === normalizedPhrase || compactText === compactPhrase) return true;
    if (normalizedPhrase.length >= 4 && normalizedText.includes(normalizedPhrase)) return true;
    return compactPhrase.length >= 4 && compactText.includes(compactPhrase);
  });
}

function buildNoisyText(baseText, noise, random) {
  const prefix = pick(random, noise.prefixes);
  const suffix = pick(random, noise.suffixes);
  const filler = pick(random, noise.fillers);
  const punctuation = pick(random, noise.punctuation);
  const parts = [];

  if (prefix && random() < 0.45) parts.push(prefix);
  if (filler && random() < 0.25) parts.push(filler);
  parts.push(baseText);
  if (suffix && random() < 0.35) parts.push(suffix);

  let text = parts.join(random() < 0.35 ? " " : "");
  if (random() < 0.2) {
    text = text.replace(/剪贴板/g, "剪切板");
  }
  if (random() < 0.12) {
    text = text.replace(/终端/g, "终端窗口");
  }
  return `${text}${punctuation}`;
}

function loadIntents(voiceActionsPath) {
  const data = tryReadJson(voiceActionsPath, { intents: [] });
  return Array.isArray(data.intents) ? data.intents.filter((intent) => intent && intent.id && intent.action) : [];
}

function loadLearnedShortcuts(shortcutsPath) {
  const data = tryReadJson(shortcutsPath, { shortcuts: [] });
  return Array.isArray(data.shortcuts) ? data.shortcuts.filter((shortcut) => shortcut && shortcut.enabled !== false) : [];
}

function buildQwenRoutingMessages({ text, context, intents, shortcuts }) {
  const candidates = (intents || []).map((intent) => ({
    id: intent.id,
    description: intent.description || "",
    examples: intent.examples || [],
    actionType: intent.action?.type || ""
  }));
  const shortcutSummary = (shortcuts || []).map((shortcut) => ({
    id: shortcut.id,
    phrases: shortcut.phrases || [],
    routeType: shortcut.routeType,
    intentId: shortcut.intentId || null
  }));

  return [
    {
      role: "system",
      content:
        "你是 CapsWriter 的本地语音路由器。只输出 JSON，不要解释。" +
        "routeType 只能是 intent、codex_terminal、ask。" +
        "如果用户请求匹配某个 intent，返回 intent 和 intentId。" +
        "如果是明确的开放任务、查询、写作、分析、需要 Codex 处理，返回 codex_terminal。" +
        "天气、带伞、查询信息这类请求即使缺少城市，也应返回 codex_terminal，让 Codex 后续追问补充信息。" +
        "如果只是城市名、地点名、单个名词，且没有 codex_session.awaitingFollowup，必须返回 ask。" +
        "如果包含这个、那个、之前说的、配置、处理一下、弄一下、搞一下等指代不清的话，必须返回 ask。" +
        "不要因为出现配置二字就选择 add_voice_intent，除非用户明确说添加、增加、创建语音意图。" +
        "如果语义含糊、缺少上下文或不该自动执行，必须返回 ask。" +
        "不要执行动作，不要编造不存在的 intentId。"
    },
    {
      role: "user",
      content: JSON.stringify({
        spoken_text: text,
        compact_context: {
          recent_utterances: context?.recentUtterances || [],
          active_window: context?.activeWindow || null,
          codex_session: context?.codexSession
            ? {
                awaitingFollowup: !!context.codexSession.awaitingFollowup,
                lastQuestion: context.codexSession.lastQuestion || "",
                lastSummary: context.codexSession.lastSummary || ""
              }
            : null
        },
        learned_shortcuts: shortcutSummary,
        intent_candidates: candidates,
        output_schema: {
          routeType: "intent|codex_terminal|ask",
          intentId: "string|null",
          confidence: "number 0..1",
          reason: "string"
        }
      })
    }
  ];
}

async function getLiveQwenDecision({ router, text, context, intents, shortcuts }) {
  const response = await router.chatCompletion(
    buildQwenRoutingMessages({ text, context, intents, shortcuts }),
    {
      temperature: 0,
      max_tokens: 180,
      response_format: { type: "json_object" }
    }
  );
  if (!response.success) {
    return {
      routeType: "ask",
      intentId: null,
      confidence: 0,
      reason: response.error || "真实服务端小模型调用失败",
      liveQwenError: response.error || response
    };
  }

  try {
    const parsed = JSON.parse(response.text);
    return {
      routeType: parsed.routeType,
      intentId: parsed.intentId ?? null,
      confidence: Number(parsed.confidence),
      reason: parsed.reason || "",
      rawText: response.text,
      endpoint: response.endpoint
    };
  } catch (error) {
    return {
      routeType: "ask",
      intentId: null,
      confidence: 0,
      reason: `真实服务端小模型返回非 JSON: ${error?.message || error}`,
      rawText: response.text
    };
  }
}

async function getTeacherDecision({ teacher, text, context, intents, shortcuts }) {
  const response = await teacher.classify({
    text,
    context,
    intents,
    shortcuts,
    activeWindow: context?.activeWindow || null
  });
  if (!response.success) {
    return {
      routeType: "ask",
      intentId: null,
      confidence: 0,
      reason: response.error || "Teacher 调用失败",
      teacherError: response.error || response
    };
  }
  return {
    ...response.decision,
    rawText: response.rawText,
    model: response.model
  };
}

function matchShortcut(text, shortcuts) {
  return (shortcuts || []).find((shortcut) => hasPhraseMatch(text, shortcut.phrases)) || null;
}

function matchIntentExample(text, intents) {
  return (intents || []).find((intent) => hasPhraseMatch(text, intent.examples)) || null;
}

function matchProgramRule(text, context, intents) {
  const normalized = normalizePhrase(text);
  const activeWindow = context?.activeWindow || null;
  const intentById = (id) => intents.find((intent) => intent.id === id);
  const routeIntent = (id, reason) => {
    const intent = intentById(id);
    return intent
      ? { routeType: "intent", source: "keyword", intentId: intent.id, confidence: 1, reason }
      : null;
  };

  if (/(新增|增加|添加|创建|进入|打开).*(语音|快捷).*(意图|命令|指令|配置)/.test(normalized)) {
    return routeIntent("add_voice_intent", "关键词命中添加语音意图");
  }
  if (/(翻译|翻成|翻一下|译成).*(中文)|((英文|剪贴板|剪切板|复制).*(翻译|翻成|译成|中文))/.test(normalized)) {
    return routeIntent("translate_clipboard_to_zh", "关键词命中翻译剪贴板");
  }
  if (/(打开|启动|新建|起|开).*(终端|命令行)/.test(normalized)) {
    return routeIntent("open_gnome_terminal", "关键词命中打开终端");
  }
  if (/(回复|输入|发送|发).*(确认)/.test(normalized)) {
    return routeIntent("reply_confirm", "关键词命中回复确认");
  }
  if (
    activeWindow?.isTerminal &&
    /(终端|输出|日志|当前).*(总结|概括|卡在哪里|卡住|阻塞|消息|内容)|((总结|概括).*(终端|输出|日志))/.test(normalized)
  ) {
    return routeIntent("summarize_current_terminal", "关键词命中总结当前终端");
  }
  if (/(天气|下雨|带伞|查一下|查询|查找|搜索|分析|研究|写一版|写个|整理|方案|测试计划|最佳实践)/.test(normalized)) {
    return {
      routeType: "codex_terminal",
      source: "keyword",
      reuseCodexSession: false,
      confidence: 1,
      reason: "关键词命中 Codex 开放任务"
    };
  }
  return null;
}

function looksLikeCodexFollowup(text, context) {
  const session = context?.codexSession;
  if (!session?.awaitingFollowup) return false;
  const compact = stripPoliteNoise(text);
  return Boolean(compact);
}

function normalizeQwenDecision(decision, threshold, intents) {
  if (!decision || typeof decision !== "object") {
    return {
      routeType: "ask",
      source: "qwen_unavailable",
      confidence: 0,
      reason: "没有服务端小模型决策"
    };
  }

  const hasConfidence = Number.isFinite(Number(decision.confidence));
  const confidence = hasConfidence ? Number(decision.confidence) : (decision.routeType ? 0.86 : 0);
  if (confidence < threshold) {
    return {
      routeType: "ask",
      source: "low_confidence",
      confidence,
      reason: decision.reason || (hasConfidence ? "服务端小模型低置信" : "服务端小模型缺少 routeType"),
      rawText: decision.rawText || "",
      endpoint: decision.endpoint || null
    };
  }

  if (decision.routeType === "intent") {
    const intent = intents.find((item) => item.id === decision.intentId);
    if (!intent) {
      return {
        routeType: "ask",
        source: "invalid_intent",
        intentId: decision.intentId || null,
        confidence,
        reason: "服务端小模型返回了不存在的 intent"
      };
    }
    return {
      routeType: "intent",
      source: "qwen_route",
      intentId: intent.id,
      confidence,
      reason: decision.reason || "服务端小模型选择 intent"
    };
  }

  if (decision.routeType === "codex_terminal") {
    return {
      routeType: "codex_terminal",
      source: "qwen_route",
      reuseCodexSession: false,
      confidence,
      reason: decision.reason || "服务端小模型选择 Codex terminal"
    };
  }

  return {
    routeType: "ask",
    source: "qwen_route",
    confidence,
    reason: decision.reason || "服务端小模型要求澄清"
  };
}

function normalizeTeacherDecision(decision, threshold, intents) {
  const routed = normalizeQwenDecision(decision, threshold, intents);
  if (routed.source === "qwen_route") {
    routed.source = "teacher";
  }
  if (routed.source === "qwen_unavailable") {
    routed.source = "teacher_unavailable";
  }
  return {
    ...routed,
    risk: decision?.risk || routed.risk,
    learnable: decision?.learnable,
    learnTarget: decision?.learnTarget,
    suggestedPhrases: decision?.suggestedPhrases || [],
    preview: decision?.preview || routed.preview,
    model: decision?.model || null
  };
}

function routeVoiceText({ text, context, intents, shortcuts, qwenDecision, teacherDecision, threshold }) {
  const shortcut = matchShortcut(text, shortcuts);
  if (shortcut) {
    return {
      routeType: "shortcut",
      source: "shortcut",
      shortcutId: shortcut.id,
      intentId: shortcut.intentId || null,
      confidence: 1,
      reason: "命中已学习快捷话术"
    };
  }

  const keyword = matchProgramRule(text, context, intents);
  if (keyword) {
    return keyword;
  }

  const intent = matchIntentExample(text, intents);
  if (intent) {
    return {
      routeType: "intent",
      source: "intent_example",
      intentId: intent.id,
      confidence: 1,
      reason: "命中 voice-actions examples"
    };
  }

  if (looksLikeCodexFollowup(text, context)) {
    return {
      routeType: "codex_terminal",
      source: "context_followup",
      reuseCodexSession: true,
      confidence: 1,
      reason: "最近 Codex 会话正在等待补充信息"
    };
  }

  if (teacherDecision) {
    return normalizeTeacherDecision(teacherDecision, threshold, intents);
  }

  return normalizeQwenDecision(qwenDecision, threshold, intents);
}

function createSamples(fixture, samplesPerScenario, seed) {
  const random = createRandom(seed);
  const noise = fixture.noise || {};
  const contexts = fixture.contexts || {};
  const samples = [];
  const disableNoise = !!fixture.defaults?.disableNoise;

  fixture.scenarios.forEach((scenario) => {
    for (let index = 0; index < samplesPerScenario; index += 1) {
      const baseText = disableNoise
        ? scenario.texts[index % scenario.texts.length]
        : pick(random, scenario.texts);
      samples.push({
        scenarioId: scenario.id,
        description: scenario.description,
        text: disableNoise ? baseText : buildNoisyText(baseText, noise, random),
        context: contexts[scenario.context] || contexts.none || {},
        qwenDecision: scenario.qwenDecision || null,
        expected: scenario.expected,
        liveExpected: scenario.liveExpected || null
      });
    }
  });

  return samples;
}

function pickRandomSamples(samples, count, seed) {
  if (!count || count >= samples.length) return samples;
  const random = createRandom(seed);
  const pool = [...samples];
  const selected = [];
  while (selected.length < count && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }
  return selected;
}

function matchesExpected(actual, expected) {
  return Object.entries(expected || {}).every(([key, value]) => actual[key] === value);
}

async function routeSample({ sample, intents, shortcuts, threshold, liveQwen, router, teacherCodex, teacher }) {
  const deterministic = routeVoiceText({
    text: sample.text,
    context: sample.context,
    intents,
    shortcuts,
    qwenDecision: null,
    teacherDecision: null,
    threshold
  });
  if (deterministic.source !== "qwen_unavailable") {
    return deterministic;
  }

  const teacherDecision = teacherCodex
    ? await getTeacherDecision({
        teacher,
        text: sample.text,
        context: sample.context,
        intents,
        shortcuts
      })
    : null;

  if (teacherDecision) {
    return routeVoiceText({
      text: sample.text,
      context: sample.context,
      intents,
      shortcuts,
      qwenDecision: null,
      teacherDecision,
      threshold
    });
  }

  const qwenDecision = liveQwen
    ? await getLiveQwenDecision({
        router,
        text: sample.text,
        context: sample.context,
        intents,
        shortcuts
      })
    : sample.qwenDecision;

  return routeVoiceText({
    text: sample.text,
    context: sample.context,
    intents,
    shortcuts,
    qwenDecision,
    teacherDecision: null,
    threshold
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = readJson(args.scenariosPath);
  const intents = loadIntents(args.voiceActionsPath);
  const learnedShortcuts = loadLearnedShortcuts(args.learnedShortcutsPath);
  const threshold = Number(fixture.defaults?.confidenceThreshold) || 0.78;
  const samplesPerScenario = args.samplesPerScenario || fixture.defaults?.samplesPerScenario || 12;
  const samples = pickRandomSamples(
    createSamples(fixture, samplesPerScenario, args.seed),
    args.randomChinese,
    args.seed
  );
  const router = args.liveQwen ? new Nx1QwenRouter() : null;
  const teacher = args.teacherCodex ? new VoiceTeacherClassifier({ cwd: path.resolve(__dirname, "..", "..") }) : null;

  const results = [];
  for (const sample of samples) {
    const actual = await routeSample({
      sample,
      intents,
      shortcuts: [...learnedShortcuts, ...(fixture.shortcuts || [])],
      threshold,
      liveQwen: args.liveQwen,
      router,
      teacherCodex: args.teacherCodex,
      teacher
    });
    const qwenMode = args.teacherCodex ? "teacher" : (args.liveQwen ? "live" : "mock");
    const expected = args.liveQwen && sample.liveExpected ? sample.liveExpected : sample.expected;
    results.push({
      ...sample,
      expected,
      qwenMode,
      actual,
      ok: matchesExpected(actual, expected)
    });
  }

  results.forEach((result) => {
    if (result.actual.rawText) {
      result.actual.rawText = String(result.actual.rawText).slice(0, 500);
    }
  });

  const passed = results.filter((item) => item.ok).length;
  const total = results.length;
  const byScenario = fixture.scenarios.map((scenario) => {
    const items = results.filter((item) => item.scenarioId === scenario.id);
    const scenarioPassed = items.filter((item) => item.ok).length;
    return {
      id: scenario.id,
      description: scenario.description,
      passed: scenarioPassed,
      total: items.length,
      rate: items.length ? scenarioPassed / items.length : 0
    };
  });

  if (args.json) {
    console.log(JSON.stringify({ mode: args.teacherCodex ? "teacher-codex" : (args.liveQwen ? "live-server-llm" : "mock"), passed, total, rate: passed / total, byScenario, results }, null, 2));
  } else {
    console.log(`MODE: ${args.teacherCodex ? "teacher-codex" : (args.liveQwen ? "live-server-llm" : "mock")}`);
    results.forEach((item, index) => {
      const status = item.ok ? "PASS" : "FAIL";
      const actualSummary = `${item.actual.routeType}/${item.actual.source}${item.actual.intentId ? `/${item.actual.intentId}` : ""}`;
      console.log(`${String(index + 1).padStart(3, "0")} ${status} [${item.scenarioId}] "${item.text}" -> ${actualSummary}`);
      if (!item.ok) {
        console.log(`    expected=${JSON.stringify(item.expected)} actual=${JSON.stringify(item.actual)}`);
      }
    });
    console.log("");
    byScenario.forEach((item) => {
      console.log(`${item.id}: ${item.passed}/${item.total} (${Math.round(item.rate * 100)}%)`);
    });
    console.log(`TOTAL: ${passed}/${total} (${Math.round((passed / total) * 100)}%)`);
  }

  if (total === 0 || passed / total < args.minRate) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
