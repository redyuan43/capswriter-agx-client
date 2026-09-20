#!/usr/bin/env node
/**
 * 长文本整理 — 端到端回放自测
 *
 * 为什么要这个脚本：单元测试只验证了 LongTextFormatter 内部。
 * 真正会翻车的三件事都在模块外面：
 *   1. 真实 ASR 长句喂进 prompt，Qwen2.5:3B 到底会不会越界去"总结"
 *   2. 终端识别拿真实窗口的 WM_CLASS 判，会不会漏判（漏判 = 往终端里
 *      粘带换行的文本 = 连续执行多条命令）
 *   3. 窗口信息读不到时，链路是"保守跳过"还是"照样排版"
 *
 * 所以这里刻意**不用 mock**：走真实的 TextPolisher、真实的
 * registerTextPolishHandlers（用一个假 ipcMain 把 handler 抓出来，
 * 参数签名和线上完全一致）、真实的 ClipboardManager/xprop、真实
 * ollama(:11434)、以及 ~/Documents/CapsWriter-Voice-Dataset 里的
 * 真实转写文本。
 *
 * 用法：
 *   node services/text-postprocess/long_text_replay.js
 *   CAPS_LONG_TEXT_MODEL=qwen2.5:3b node services/text-postprocess/long_text_replay.js
 *
 * 退出码：0 = 全部符合预期；1 = 有 case 不符合预期（会打印 FAIL 明细）。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");

const { TextPolisher } = require(path.join(ROOT, "src/platform/electron/textPolish"));
const { LongTextFormatter, bigramCoverage } = require(path.join(ROOT, "src/helpers/longTextFormatter"));
const { registerTextPolishHandlers } = require(path.join(ROOT, "src/platform/electron/ipc/textPolishHandlers"));
const { isTerminalWindow } = require(path.join(ROOT, "src/helpers/terminalFocus"));
const ClipboardManager = require(path.join(ROOT, "src/helpers/clipboard"));

const ENDPOINT = process.env.CAPS_LONG_TEXT_ENDPOINT || "http://127.0.0.1:11434";
const MODEL = process.env.CAPS_LONG_TEXT_MODEL || "qwen2.5:3b";
const DATASET = path.join(os.homedir(), "Documents/CapsWriter-Voice-Dataset/metadata.jsonl");
const MIN_CHARS = 40;

const DISPLAY = process.env.DISPLAY || ":1";
const XAUTHORITY = process.env.XAUTHORITY || `/run/user/${process.getuid()}/gdm/Xauthority`;

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sh(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      env: { ...process.env, DISPLAY, XAUTHORITY },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** 去掉空白/标点/符号后的字数——和 textPolish.shouldRunLongFormat 同一口径 */
function contentLength(text) {
  return String(text || "").replace(/[\s\p{P}\p{S}]/gu, "").length;
}

// ---------------------------------------------------------------- 真实语料

function loadCorpus() {
  if (!fs.existsSync(DATASET)) {
    console.error(`找不到真实语料：${DATASET}`);
    process.exit(1);
  }
  const rows = [];
  for (const line of fs.readFileSync(DATASET, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const text = (d.asr_text || d.raw_asr_text || "").trim();
    if (!text) continue;
    rows.push({ text, mode: d.mode, createdAt: d.created_at });
  }
  return rows;
}

// ---------------------------------------------------------------- 真实窗口

function listRealWindows() {
  const ids = sh('xdotool search --onlyvisible --name ".*"').split("\n").filter(Boolean);
  const out = [];
  for (const id of ids) {
    const raw = sh(`xprop -id ${id} WM_CLASS _NET_WM_NAME`);
    const classMatch = raw.match(/WM_CLASS\([^)]*\)\s*=\s*(.+)/);
    const titleMatch = raw.match(/_NET_WM_NAME\([^)]*\)\s*=\s*(.+)/);
    const parse = (raw2 = "") =>
      (raw2.match(/"([^"]*)"/g) || []).map((p) => p.replace(/^"|"$/g, "")).filter(Boolean).join(" ");
    const windowClass = parse(classMatch ? classMatch[1] : "");
    if (!windowClass) continue;
    out.push({ id, windowClass, windowTitle: parse(titleMatch ? titleMatch[1] : "") });
  }
  return out;
}

/** 起一个真终端出来当靶子；返回 {ids, kill()}。ids 含 frame/client 全部窗口。 */
function launchRealTerminal() {
  const child = spawn("gnome-terminal", [], {
    env: { ...process.env, DISPLAY, XAUTHORITY },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  let ids = [];
  for (let i = 0; i < 20 && !ids.length; i += 1) {
    execSync("sleep 0.4");
    ids = sh('xdotool search --class gnome-terminal').split("\n").filter(Boolean);
  }
  return {
    ids,
    kill: () => {
      // 精确按 class 杀，别用 pkill -f 字符串（会连自己一起杀）
      try {
        execSync("pkill -x gnome-terminal-server", { stdio: "ignore" });
      } catch { /* 已经退出了 */ }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch { /* 同上 */ }
    },
  };
}

// ---------------------------------------------------------------- 链路装配

function buildPipeline() {
  const logger = {
    info: () => {},
    warn: (m, d) => console.log(`   · [warn] ${m}`, d ? JSON.stringify(d) : ""),
    error: () => {},
    debug: () => {},
  };
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "caps-replay-"));
  const longFormatter = new LongTextFormatter({ endpoint: ENDPOINT, model: MODEL, logger });
  const textPolisher = new TextPolisher({ dataDirectory, logger, longFormatter });
  const clipboardManager = new ClipboardManager(logger);

  const ctx = {
    textPolisher,
    windowManager: { previousActiveWindow: null },
    clipboardManager,
    logger,
  };

  // 用假 ipcMain 把**真实的** handler 抓出来，签名跟线上一致
  const handlers = new Map();
  registerTextPolishHandlers(ctx, { handle: (channel, fn) => handlers.set(channel, fn) });

  return { ctx, handlers, longFormatter, dataDirectory };
}

async function drive(handlers, ctx, { text, targetWindowId }) {
  ctx.windowManager.previousActiveWindow = targetWindowId;
  const started = Date.now();
  const res = await handlers.get("polish-text")(null, text, {
    hotRule: true,
    punctuation: "off",
    longFormat: { enabled: true, minChars: MIN_CHARS },
  });
  return { res, wallMs: Date.now() - started };
}

function stageOf(res, name) {
  return (res.stages || []).find((s) => s.stage === name) || null;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  console.log("=".repeat(78));
  console.log("长文本整理 · 端到端回放");
  console.log(`  端点 ${ENDPOINT}   模型 ${MODEL}   DISPLAY ${DISPLAY}`);
  console.log("=".repeat(78));

  const { ctx, handlers, longFormatter, dataDirectory } = buildPipeline();

  // ---- 0. 服务探活
  const probe = await longFormatter.probe();
  record("ollama 服务与模型可用", probe.available === true, JSON.stringify(probe));
  if (!probe.available) {
    console.log("\n服务不可用，后面的 case 没有意义，直接退出。");
    process.exit(1);
  }
  console.log("  预热模型…");
  const warm = await longFormatter.warmup();
  console.log(`  预热完成 ${warm?.elapsed_ms ?? "?"}ms`);

  // ---- 1. 真实窗口：终端识别的误判/漏判
  const terminal = launchRealTerminal();
  const windows = listRealWindows();
  // 同一个终端会有 frame + client 两个 X 窗口，取能读到 WM_CLASS 的那个
  const terminalMeta = windows.find((w) => terminal.ids.includes(w.id)) || null;
  const terminalIds = new Set(terminal.ids);

  if (terminalMeta) {
    const verdict = isTerminalWindow(terminalMeta.windowClass, terminalMeta.windowTitle);
    record(
      "真实 gnome-terminal 被判为终端",
      verdict === true,
      `class="${terminalMeta.windowClass}" title="${terminalMeta.windowTitle}" → ${verdict}`
    );
  } else {
    record("真实 gnome-terminal 被判为终端", false, "没能起出 gnome-terminal，无法验证");
  }

  // gnome-terminal 自己就是终端，不算误判；只看其它真实应用窗口
  const others = windows.filter((w) => !terminalIds.has(w.id));
  const falsePositives = others.filter((w) => isTerminalWindow(w.windowClass, w.windowTitle));
  record(
    "真实非终端窗口零误判",
    others.length > 0 && falsePositives.length === 0,
    falsePositives.length
      ? `被误判为终端：${falsePositives.map((w) => w.windowClass).join(" / ")}`
      : `检查了 ${others.length} 个真实窗口`
  );

  // 挑一个真实非终端窗口当"正常粘贴目标"
  const normalWindow =
    others.find((w) => /google-chrome/i.test(w.windowClass)) || others[0] || null;
  if (!normalWindow) {
    console.log("\n桌面上没有可用的非终端窗口，跳过正向 case。");
  }

  // ---- 2. 真实长句：整理应该发生，且保真
  const corpus = loadCorpus();
  const longSamples = corpus
    .filter((r) => contentLength(r.text) >= 80)
    .sort((a, b) => contentLength(b.text) - contentLength(a.text))
    .slice(0, 8);

  record("真实语料里存在长句样本（>=80 字）", longSamples.length >= 5, `取到 ${longSamples.length} 条`);

  if (normalWindow && longSamples.length) {
    console.log(`\n--- 正向：目标窗口 ${normalWindow.windowClass}（非终端）---`);
    let ran = 0;
    let segmented = 0;
    let degraded = 0;
    const elapsedList = [];
    for (const [i, sample] of longSamples.entries()) {
      const { res, wallMs } = await drive(handlers, ctx, {
        text: sample.text,
        targetWindowId: normalWindow.id,
      });
      const st = stageOf(res, "long_format");
      if (st) {
        ran += 1;
        elapsedList.push(st.elapsed_ms ?? wallMs);
        const lines = String(res.text).trim().split(/\n+/).filter(Boolean);
        if (lines.length >= 2) segmented += 1;
      }
      if (res.degraded) degraded += 1;
      const cover = bigramCoverage(sample.text, res.text);
      console.log(
        `  [${i + 1}] ${contentLength(sample.text)}字 → ${contentLength(res.text)}字  ` +
          `段数=${String(res.text).trim().split(/\n+/).filter(Boolean).length}  ` +
          `覆盖=${cover.toFixed(3)}  ${st ? `${st.elapsed_ms}ms` : "未整理"}  ` +
          `${res.degraded || ""}`
      );
    }
    record("长句全部触发了整理", ran === longSamples.length, `${ran}/${longSamples.length} 触发`);
    record("整理结果确实分段了", segmented >= Math.ceil(longSamples.length * 0.75), `${segmented}/${longSamples.length} 分了段`);
    record("长句无降级回退", degraded === 0, degraded ? `${degraded} 条降级` : "0 条降级");
    if (elapsedList.length) {
      const avg = elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length;
      console.log(`  平均推理耗时 ${avg.toFixed(0)}ms（上限 ${(await longFormatter.probe()).timeout_ms ?? "—"}ms）`);
    }
  }

  // ---- 3. 终端避让：目标窗口是终端时必须整条跳过
  if (terminalMeta) {
    const sample = longSamples[0] || corpus[0];
    const { res } = await drive(handlers, ctx, { text: sample.text, targetWindowId: terminalMeta.id });
    const ran = Boolean(stageOf(res, "long_format"));
    record("目标窗口是真实终端时不整理", ran === false, ran ? "仍然做了排版，终端里会执行命令！" : "已跳过");
    record(
      "终端场景文本原样返回（无换行）",
      !/\n/.test(String(res.text)),
      /\n/.test(String(res.text)) ? "返回文本里含换行" : "无换行"
    );
  }

  // ---- 4. 窗口信息读不到：必须是保守跳过，不能照样排版
  const sample = longSamples[0] || corpus[0];
  const unknownWin = await drive(handlers, ctx, { text: sample.text, targetWindowId: "999999999" });
  const unknownRan = Boolean(stageOf(unknownWin.res, "long_format"));
  record(
    "窗口信息读不到时保守跳过（不能排版）",
    unknownRan === false,
    unknownRan ? "读不到窗口照样排版了——这是危险方向" : "已跳过"
  );

  const noWin = await drive(handlers, ctx, { text: sample.text, targetWindowId: null });
  const noWinRan = Boolean(stageOf(noWin.res, "long_format"));
  record(
    "没有记录到目标窗口时保守跳过",
    noWinRan === false,
    noWinRan ? "没有窗口信息照样排版了" : "已跳过"
  );

  // ---- 5. 短句不触发
  const shortSample = corpus.find((r) => contentLength(r.text) > 0 && contentLength(r.text) < 30);
  if (shortSample && normalWindow) {
    const { res } = await drive(handlers, ctx, {
      text: shortSample.text,
      targetWindowId: normalWindow.id,
    });
    const ran = Boolean(stageOf(res, "long_format"));
    record("短句（<40 字）不触发整理", ran === false, `${contentLength(shortSample.text)} 字 → ${ran ? "触发了" : "跳过"}`);
  }

  // ---- 6. 服务挂掉：不能崩、不能丢字
  if (normalWindow) {
    const deadFormatter = new LongTextFormatter({ endpoint: "http://127.0.0.1:1", model: MODEL, timeoutMs: 1500 });
    const dead = new TextPolisher({ dataDirectory, longFormatter: deadFormatter });
    const deadCtx = {
      textPolisher: dead,
      windowManager: { previousActiveWindow: normalWindow.id },
      clipboardManager: ctx.clipboardManager,
      logger: ctx.logger,
    };
    const deadHandlers = new Map();
    registerTextPolishHandlers(deadCtx, { handle: (ch, fn) => deadHandlers.set(ch, fn) });
    const res = await deadHandlers.get("polish-text")(null, sample.text, {
      hotRule: true,
      punctuation: "off",
      longFormat: { enabled: true, minChars: MIN_CHARS },
    });
    record(
      "ollama 不可用时降级且不丢字",
      res.degraded && String(res.text).length > 0,
      `degraded=${res.degraded} 文本长度=${String(res.text).length}`
    );
  }

  terminal.kill();
  fs.rmSync(dataDirectory, { recursive: true, force: true });

  console.log("\n" + "=".repeat(78));
  const pass = results.filter((r) => r.ok).length;
  console.log(`结果：${pass}/${results.length} PASS${failures ? `，${failures} FAIL` : ""}`);
  console.log("=".repeat(78));
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error("回放脚本自身出错：", error);
  process.exit(2);
});
