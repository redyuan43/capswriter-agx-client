/**
 * 长文本整理 prompt 评测（离线，直接打本机 ollama）
 *
 * 背景：Qwen3-4B 在 think:false 下遇到"角色 + 多条规则"型 prompt 时，
 * 会把要求当成待分析文本、在正文里自言自语展开，输出长度暴涨到原文的 6 倍。
 * 本脚本对比几种 prompt 形态，看哪种能让 4B 稳定执行。
 *
 * 运行：node services/text-postprocess/long_text_eval.js
 */

const fs = require("fs");
const path = require("path");

const ENDPOINT = process.env.OLLAMA_ENDPOINT || "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3:4b";

const SAMPLES = [
  {
    name: "长句·多问题",
    text: "现在手机界面的交互界面还是有问题。第一个就是你下载到手机上，如果是在下载过程中能看到状态的变化，下载完了也能看到状态的。上同步也需要看到服务器上的变化，也需要看到手机上服务器同步时候的楼定状态以及。及服务器同步完了之后的状态。同理，在服务器端也要能看到实时同步的状态，这样才合理。然后整个过程可以用。可以用图标来表示，不见得完全需要用文字。",
  },
  {
    name: "短句·应保持原样",
    text: "提交 commit，然后提交到 GitHub 上去。",
  },
  {
    name: "长句·三点枚举",
    text: "这个地方肯定是先调 Video Analysis 的 ASR 功能。至于最后怎么去选择，你有没有更好的方案？给我一个综合的。第一个，如果是关键字匹配，我担心效果没那么好，但是可能关键。关键词匹配速度会更快，但是如果这个时候用一个模型来去判断的话，本身语音翻译完的的数据量特别大，如果用模型去匹配，可能处理的时间比较久，这个地方比较纠结。",
  },
];

// A：极简规则（去掉全部举例与解释）
const P_SIMPLE = `整理下面这段语音转写。只做三件事：
1. 删掉"呃、嗯、那个、就是说"这类口头语
2. 改掉明显的错别字
3. 按意思分段（用换行）

除了这三件事，一个字都不要改。不要总结，不要改写句子，不要加任何说明。

原文：{text}

整理后：`;

// B：few-shot（用示例代替规则描述）
const P_FEWSHOT = `把语音转写整理成通顺的分段文字。

示例：
原文：然后那个，我觉得这个方案可以。呃，但是第二个问题就是说它太慢了。太慢了，得改。
整理后：我觉得这个方案可以。

但是第二个问题，它太慢了，得改。

现在整理下面这段，规则和示例一样：删口头语、改错别字、按意思分段，其余一字不改。

原文：{text}

整理后：`;

// C：当前仓库里的长版（对照）
const P_VERBOSE = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "helpers", "longTextFormatter.js"),
  "utf8"
).match(/const PROMPT_TEMPLATE = `([\s\S]*?)`;/)[1].replace("${text}", "{text}");

/**
 * 去掉空白与标点后计数。
 * 注意不能用 \W：JS 的 \w 只含 ASCII 字母数字，汉字会被 \W 匹配掉，
 * 结果长度恒为 0（Python 的 \w 含汉字，两者语义不同，这个坑踩过一次）。
 */
function strip(s) {
  return String(s || "").replace(/[\s\p{P}\p{S}]/gu, "");
}

async function call(prompt) {
  const started = Date.now();
  const response = await fetch(`${ENDPOINT}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 1024 },
    }),
  });
  const data = await response.json();
  const content = (data?.message?.content || "").trim();
  const thinking = (data?.message?.thinking || "").trim();
  return {
    content,
    thinkingLen: thinking.length,
    elapsed: (Date.now() - started) / 1000,
    evalCount: data?.eval_count || 0,
    doneReason: data?.done_reason || "",
  };
}

async function main() {
  const variants = [
    ["A 极简规则", P_SIMPLE],
    ["B few-shot", P_FEWSHOT],
    ["C 长版(仓库现有)", P_VERBOSE],
  ];

  for (const sample of SAMPLES) {
    console.log("=".repeat(78));
    console.log(`样本：${sample.name}（${strip(sample.text).length} 字）`);
    console.log("=".repeat(78));

    for (const [label, tpl] of variants) {
      const prompt = tpl.replace("{text}", sample.text);
      let r;
      try {
        r = await call(prompt);
      } catch (error) {
        console.log(`  [${label}] 调用失败：${error.message}\n`);
        continue;
      }
      const a = strip(sample.text).length;
      const b = strip(r.content).length;
      const ratio = a ? b / a : 0;
      const verdict = ratio < 0.7 ? "拒绝(太短)" : ratio > 1.15 ? "拒绝(太长)" : "通过";
      const lines = r.content.split("\n").filter((l) => l.trim()).length;
      console.log(
        `  [${label}] ${r.elapsed.toFixed(2)}s | ${r.evalCount}tok | ` +
        `保真比 ${ratio.toFixed(2)} → ${verdict} | 段数 ${lines} | think ${r.thinkingLen}`
      );
      console.log(`    ${r.content.slice(0, 150).replace(/\n/g, " ⏎ ")}${r.content.length > 150 ? "…" : ""}`);
      console.log();
    }
  }
}

main().catch((error) => {
  console.error("评测失败：", error);
  process.exit(1);
});
