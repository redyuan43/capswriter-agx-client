#!/usr/bin/env node
/**
 * 保真审计：量化 7B 整理的"改偏率"，验证保真校验四道关的实际效果。
 *
 * 用法：node services/text-postprocess/fidelity_audit.js
 *   N=60 MIN_CHARS=50 node ...   # 调样本数与最短长度
 *
 * 从真实语料抽长口述 → 每条跑两遍 ollama 7B → 用**生产 validate()**
 * （含 v1.0.31 第四道关 rewriteRatio）逐条判定：
 *   ratio            长度比（第一关）
 *   spacey           逐词空格（第二关）
 *   coverage         双字组覆盖率（第三关）
 *   rewrite          字符级改写嫌疑度 = min(deleted, inserted)/len(原文)（第四关）
 *                    —— 只删词时 inserted≈0 → rewrite≈0（合法整理）
 *                    —— 同义替换时 deleted≈inserted>0 → rewrite 高（改偏）
 *
 * 输出：拦截/放行统计、rewrite 分布、同输入两遍输出不一致率。
 * 改阈值（MAX_REWRITE_RATIO 等）或换模型后应重跑本脚本看误伤率。
 */
process.env.NODE_PATH = require("path").join(__dirname, "..", "node_modules");
require("module").Module._initPaths();
const fs = require("fs");
const path = require("path");
const {
  LongTextFormatter, PROMPT_TEMPLATE, bigramCoverage, spaceyRatio,
} = require(path.join(__dirname, "..", "..", "src/helpers/longTextFormatter.js"));

const DATASET = path.join(require("os").homedir(), "Documents/CapsWriter-Voice-Dataset/metadata.jsonl");
const ENDPOINT = "http://127.0.0.1:11434";
const MODEL = "qwen2.5:7b-instruct-q4_K_M";
const N = Number(process.env.N || 40);
const MIN_CHARS = Number(process.env.MIN_CHARS || 60);

const strip = (s) => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");

// --- LCS（Hunt–Szymanski 太复杂，直接 O(n*m) DP + 滚动数组） ---
function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const ca = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = ca === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function fidelityMetrics(original, formatted) {
  const a = strip(original);
  const b = strip(formatted);
  const ratio = a.length ? b.length / a.length : 1;
  const coverage = bigramCoverage(a, b);
  const spacey = spaceyRatio(formatted);
  const kept = lcsLength(a, b);
  const deleted = a.length - kept;
  const inserted = b.length - kept;
  const rewrite = a.length ? Math.min(deleted, inserted) / a.length : 0;
  return { ratio, coverage, spacey, rewrite, aLen: a.length, kept, deleted, inserted };
}

// 现有三道关的复刻（阈值同生产）
const MIN_RATIO = 0.7, MAX_RATIO = 1.15, MAX_SPACEY = 0.15;
const COV_LONG = 0.9, COV_SHORT = 0.75, STRICT = 80;
function currentValidate(m) {
  if (m.ratio < MIN_RATIO) return `too_short(${m.ratio.toFixed(2)})`;
  if (m.ratio > MAX_RATIO) return `too_long(${m.ratio.toFixed(2)})`;
  if (m.spacey > MAX_SPACEY) return `space_garbage(${m.spacey.toFixed(2)})`;
  const th = m.aLen >= STRICT ? COV_LONG : COV_SHORT;
  if (m.coverage < th) return `rewritten(cov=${m.coverage.toFixed(2)})`;
  return null;
}

async function ollamaFormat(text, timeoutMs = 60000) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: PROMPT_TEMPLATE.replace("${text}", text) }],
    stream: false,
    options: { temperature: 0.1, num_predict: Math.max(512, text.length * 3) },
  };
  const res = await fetch(`${ENDPOINT}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return String(data?.message?.content || "");
}

function pickSamples() {
  const lines = fs.readFileSync(DATASET, "utf8").trim().split("\n");
  const pool = [];
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const t = String(rec.raw_asr_text || "");
    if (strip(t).length >= MIN_CHARS) pool.push(t);
  }
  // 均匀取样，避免只抽到某几天
  const step = Math.max(1, Math.floor(pool.length / N));
  const out = [];
  for (let i = 0; i < pool.length && out.length < N; i += step) out.push(pool[i]);
  return out;
}

function diffPreview(a, b) {
  // 简易高亮：找到 LCS 之外的片段对（粗略，仅给人看）
  return { orig: a.slice(0, 120), fmt: b.slice(0, 120) };
}

(async () => {
  const samples = pickSamples();
  console.log(`样本 ${samples.length} 条（去标点后 >= ${MIN_CHARS} 字），模型 ${MODEL}，温度 0.1\n`);
  const fmt = new LongTextFormatter({});

  const rows = [];
  let unstable = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const text = samples[i];
    let out1, out2;
    try {
      out1 = await ollamaFormat(text);
      out2 = await ollamaFormat(text);
    } catch (e) {
      console.log(`[${i}] 请求失败: ${e.message}`); continue;
    }
    const clean1 = fmt.normalizeParagraphs(fmt.stripNoise(out1));
    const clean2 = fmt.normalizeParagraphs(fmt.stripNoise(out2));
    if (clean1 !== clean2) unstable += 1;

    // 直接用生产 validate()（含 v1.0.31 第四道关），不做本地复刻
    const check = fmt.validate(text, clean1);
    const m1 = { ...check, aLen: strip(text).length };
    const blocked1 = check.ok ? null : check.reason;
    rows.push({ i, text, out: clean1, m: m1, blocked: blocked1 });

    const flag = blocked1 ? `BLOCKED(${blocked1})` : (m1.rewrite > 0.03 ? "PASS-rewrite>=3%" : "ok");
    console.log(`[${i}] len=${m1.aLen} ratio=${m1.ratio.toFixed(2)} cov=${m1.coverage.toFixed(2)} rewrite=${(m1.rewrite * 100).toFixed(1)}% ${flag}`);
  }

  // 汇总：现有校验放行的样本中 rewrite 分布
  const passed = rows.filter((r) => !r.blocked);
  const buckets = { "0-1%": 0, "1-3%": 0, "3-5%": 0, "5-8%": 0, ">8%": 0 };
  for (const r of passed) {
    const p = r.m.rewrite * 100;
    if (p < 1) buckets["0-1%"] += 1;
    else if (p < 3) buckets["1-3%"] += 1;
    else if (p < 5) buckets["3-5%"] += 1;
    else if (p < 8) buckets["5-8%"] += 1;
    else buckets[">8%"] += 1;
  }
  console.log(`\n===== 汇总 =====`);
  console.log(`总样本 ${rows.length}，现有校验拦截 ${rows.length - passed.length}，放行 ${passed.length}`);
  console.log(`同输入两遍输出不一致：${unstable}/${rows.length}`);
  console.log(`放行样本改写嫌疑度分布:`, JSON.stringify(buckets));

  const bad = passed.filter((r) => r.m.rewrite > 0.05).sort((a, b) => b.m.rewrite - a.m.rewrite);
  console.log(`\n===== 改写嫌疑 >5% 的 case（现有校验放行）×${bad.length} =====`);
  for (const r of bad.slice(0, 8)) {
    console.log(`\n[${r.i}] rewrite=${(r.m.rewrite * 100).toFixed(1)}% cov=${r.m.coverage.toFixed(2)} ratio=${r.m.ratio.toFixed(2)}`);
    const a = strip(r.text), b = strip(r.out);
    console.log(`  原文: ${r.text.slice(0, 150).replace(/\n/g, " ")}`);
    console.log(`  输出: ${r.out.slice(0, 150).replace(/\n/g, " ")}`);
    console.log(`  [strip后 kept=${r.m.kept} del=${r.m.deleted} ins=${r.m.inserted} aLen=${r.m.aLen}]`);
  }
})();
