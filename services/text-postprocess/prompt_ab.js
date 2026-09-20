/**
 * 长文本整理 prompt 消融实验（离线，直接打本机 ollama）
 *
 * 起因：2026-09-20 原哥真实口述 204 字，长文本整理跑完 ratio=1（一字未改），
 * 输出是"每句话单独一行"共 8 行。他反馈"断句还有问题"。
 *
 * 复盘发现两个独立问题：
 *   A. 现有 prompt 的 few-shot 示例，输出恰好是"两句两行"——3B 学到了
 *      "每句换行"这个形式，把 ASR 的句号直接换成换行符。
 *   B. ASR 服务端的误断句（"靠启动日志和。接线校验确认的"）被原样保留。
 *      全量 3814 条语料统计：8.75% 的句子句末落在连词/介词上。
 *
 * 本脚本对比几种 prompt 形态谁能修掉 A，并用规则验证 B。
 *
 * 运行：
 *   node services/text-postprocess/prompt_ab.js            # 全部样本 × 全部 prompt
 *   IDX=0,3 node services/text-postprocess/prompt_ab.js    # 只跑第 0、3 条语料
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const DB = path.join(os.homedir(), "Documents/CapsWriter-Voice-Dataset/metadata.jsonl");

const contentLen = (t) => String(t || "").replace(/[\s\p{P}\p{S}]/gu, "").length;
const paragraphs = (t) => String(t || "").trim().split(/\n+/).filter(Boolean);

/** 双字组覆盖率，和线上同一口径 */
function bigramCoverage(a, b) {
  const A = new Set();
  for (let i = 0; i < a.length - 1; i += 1) A.add(a.slice(i, i + 2));
  if (!A.size || b.length < 2) return b.length < 2 ? 1 : 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    total += 1;
    if (A.has(b.slice(i, i + 2))) hit += 1;
  }
  return total ? hit / total : 0;
}

// ---------------------------------------------------------------- prompt 变体

const HEAD = `把下面这段语音转写整理一下：删掉"呃、嗯、那个、就是说"这类口头语，改掉明显的错别字，按意思分成几段。其余一个字都不要改。不要总结，不要解释。\n\n`;

/** A：线上现状（示例输出是"两句两行"，3B 学成了"每句一行"） */
const P_CURRENT = `${HEAD}示例：
原文：然后那个，我觉得这个方案可以。呃，但是第二个问题就是说它太慢了。
整理后：我觉得这个方案可以。
但是第二个问题，它太慢了。

下面这段照上面的做法整理：
\${text}

整理后：`;

/** B：示例改成"合并 + 分段"双动作（4 句 → 2 段，句内合并） */
const P_MERGE = `${HEAD}示例：
原文：然后那个，我觉得这个方案可以。呃，但是第二个问题就是说它太慢了。另外还有一个事，就是它不太适合我们现在的场景，因为性能不够。
整理后：我觉得这个方案可以，但是第二个问题它太慢了。

另外，它不适合我们现在的场景，因为性能不够。

下面这段照上面的做法整理：
\${text}

整理后：`;

/** C：B + 显式禁止"一句话一行"（3B 需要把反例说破才不犯） */
const P_MERGE_EXPLICIT = `${HEAD}示例：
原文：然后那个，我觉得这个方案可以。呃，但是第二个问题就是说它太慢了。另外还有一个事，就是它不太适合我们现在的场景，因为性能不够。
整理后：我觉得这个方案可以，但是第二个问题它太慢了。

另外，它不适合我们现在的场景，因为性能不够。

注意：上面原文有四句话，整理后只有两段。关系紧密的短句要并进同一句、同一段，
不要一句话一行，也不要每句话都换行。

下面这段照上面的做法整理：
\${text}

整理后：`;

/** D：C + 允许修正被切碎的句子（针对 ASR 误断句） */
const P_MERGE_FIXBREAK = `${HEAD}示例：
原文：然后那个，我觉得这个方案可以。呃，但是第二个问题就是说它太慢了。另外还有一个事，就是它不太适合我们现在的场景，因为性能不够。
整理后：我觉得这个方案可以，但是第二个问题它太慢了。

另外，它不适合我们现在的场景，因为性能不够。

注意：
1. 上面原文有四句话，整理后只有两段。关系紧密的短句要并进同一句、同一段，
   不要一句话一行，也不要每句话都换行。
2. 转写有时会在半句话中间就加句号（比如"靠启动日志和。接线校验"），
   那是识别错误，要接回去改成逗号。

下面这段照上面的做法整理：
\${text}

整理后：`;

const VARIANTS = [
  { key: "A-现状", prompt: P_CURRENT },
  { key: "B-合并示例", prompt: P_MERGE },
  { key: "C-禁一句一行", prompt: P_MERGE_EXPLICIT },
  { key: "D-C+修误断", prompt: P_MERGE_FIXBREAK },
];

// ------------------------------------------------------------------ 规则层

// 句末落在这些字上，说明 ASR 在半句中误加了句号（连词/介词/量词，不可能是句尾）
const TAIL_STOPWORDS = new Set(
  "和与或并跟同及以及但因为所以如果虽然然后把被将对从向往就还也都又更最太很".split("")
);

/**
 * 规则修 ASR 误断句：句末是连词/介词 → 句号降级成逗号。
 * 确定性、零 LLM 风险，可独立于 prompt 使用。
 */
function fixAsrBreaks(text) {
  const TAIL = new RegExp(`[${[...TAIL_STOPWORDS].join("")}]`);
  return String(text || "").replace(/([^。！？!?…，、；：]{2,})([。！？!?…])/g, (m, body, closer) => {
    if (!TAIL.test(body.slice(-1))) return m;
    return `${body}，`;
  });
}

// ------------------------------------------------------------------ 语料

function loadSamples() {
  const rows = [];
  for (const line of fs.readFileSync(DB, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = (d.asr_text || d.text || "").trim();
    if (t) rows.push({ text: t, at: d.created_at || "" });
  }
  // 挑长句：太长跑得慢，太短触发不了整理
  const picked = rows.filter((r) => contentLen(r.text) >= 90 && contentLen(r.text) <= 320);
  picked.sort((a, b) => contentLen(b.text) - contentLen(a.text));
  return { all: picked, latest: rows.slice(-3) };
}

async function ask(prompt, text) {
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt.replace("${text}", text) }],
      stream: false,
      keep_alive: "30m",
      options: { temperature: 0.2, num_predict: Math.max(256, text.length * 2) },
    }),
  });
  const data = await res.json();
  const raw = String(data?.message?.content ?? "").trim();
  // 剥掉代码围栏与"整理后："前缀（和线上同规则）
  return {
    text: raw
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/```$/, "")
      .replace(/^\s*(?:整理后|整理结果|输出|结果)[:：\s]*/, "")
      .trim(),
    elapsed: Date.now() - started,
  };
}

(async () => {
  const { all, latest } = loadSamples();
  let samples;
  if (process.env.IDX) {
    samples = process.env.IDX.split(",").map((i) => all[Number(i)]).filter(Boolean);
  } else {
    // 默认：最长的 2 条 + 最新 2 条（最新的是刚口述的真人语音）
    samples = [all[0], all[1], ...latest.slice(0, 2)].filter(Boolean);
  }

  console.log(`模型 ${MODEL} / 样本 ${samples.length} 条 / prompt 变体 ${VARIANTS.length} 套\n`);
  console.log("=".repeat(78));
  console.log("规则层 fixAsrBreaks 的独立效果");
  for (const s of samples) {
    const fixed = fixAsrBreaks(s.text);
    if (fixed !== s.text) {
      console.log(`\n原文：${s.text.slice(0, 90)}...`);
      console.log(`修正：${fixed.slice(0, 90)}...`);
    }
  }
  console.log("\n" + "=".repeat(78));

  for (const [si, s] of samples.entries()) {
    const stripped = s.text.replace(/[\s\p{P}\p{S}]/gu, "");
    console.log(`\n### 样本 ${si + 1}  原文 ${contentLen(s.text)} 字  ${s.at}`);
    console.log(`原文：${s.text}`);
    for (const v of VARIANTS) {
      const r = await ask(v.prompt, s.text);
      const outStripped = r.text.replace(/[\s\p{P}\p{S}]/gu, "");
      const cov = bigramCoverage(stripped, outStripped);
      const ratio = outStripped.length / stripped.length;
      const segs = paragraphs(r.text);
      console.log(
        `\n  [${v.key}] ${r.elapsed}ms  段数=${segs.length}  ratio=${ratio.toFixed(3)}  coverage=${cov.toFixed(3)}` +
          `  段落长度=${segs.map((p) => contentLen(p)).join("/")}`
      );
      console.log(
        "  " +
          r.text
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n")
      );
    }
  }
})();
