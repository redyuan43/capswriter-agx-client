#!/usr/bin/env node
/**
 * 用真实的 hotRuleReplace 模块 + 真实的 3807 条录音回归，验证新规则在 JS 正则
 * 语义下的实际效果。Python 分析与 JS 在 \b / lookbehind 上有语义差异，必须实测。
 *
 * 用法: node services/text-postprocess/rule_regression.js [--show K]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { HotRuleReplacer } = require("../../src/helpers/hotRuleReplace");

const SHOW = (() => {
  const i = process.argv.indexOf("--show");
  return i > -1 ? Number(process.argv[i + 1]) : 8;
})();

const ROOT = path.join(__dirname, "..", "..");
const RULE_FILE = path.join(ROOT, "assets", "hot-rule.txt");
const META = path.join(os.homedir(), "Documents", "CapsWriter-Voice-Dataset", "metadata.jsonl");

const replacer = new HotRuleReplacer({ filePath: RULE_FILE, fs });
const count = replacer.load(fs.readFileSync(RULE_FILE, "utf8"));
console.log(`规则条数: ${count}`);

const recs = [];
for (const line of fs.readFileSync(META, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const d = JSON.parse(line);
    const t = d.final_text || d.text || "";
    if (t.trim()) recs.push([d.created_at || "", t]);
  } catch {
    /* 跳过坏行 */
  }
}
console.log(`样本: ${recs.length} 条\n`);

const changed = [];
let errCount = 0;
for (const [ts, text] of recs) {
  const out = replacer.apply(text);
  if (out.error) errCount += 1;
  if (out.text !== text) changed.push([ts, text, out.text]);
}

console.log(`改动条目: ${changed.length} / ${recs.length}  (${((changed.length / recs.length) * 100).toFixed(1)}%)`);
console.log(`规则运行时报错: ${errCount}\n`);

console.log(`--- 改动实拍（最新 ${SHOW} 条）---`);
for (const [ts, before, after] of changed.slice(-SHOW)) {
  console.log(`  [${String(ts).slice(0, 16)}]`);
  console.log(`    - ${before.slice(0, 110)}`);
  console.log(`    + ${after.slice(0, 110)}`);
}

// ---- 误伤检查：去空白后，字符序列只允许「大小写变化」，不允许增删 ----
const strip = (s) => s.replace(/\s/g, "");
const bad = [];
for (const [, before, after] of changed) {
  const b = strip(before);
  const a = strip(after);
  if (b.length !== a.length) {
    // 长度变化只能来自 tcale→Tailscale / webstick→VibeStick 这类专名归一
    if (!/Tailscale|VibeStick/.test(after)) bad.push(["长度变化", before, after]);
    continue;
  }
  for (let i = 0; i < b.length; i += 1) {
    if (b[i] !== a[i] && b[i].toLowerCase() !== a[i].toLowerCase()) {
      bad.push(["非大小写差异", before, after]);
      break;
    }
  }
}
console.log(`\n--- 误伤检查 ---`);
if (!bad.length) {
  console.log("  OK 所有改动仅为「插入空格」或「专名归一」，无汉字/字母增删");
} else {
  console.log(`  ! 可疑 ${bad.length} 条:`);
  for (const [kind, before, after] of bad.slice(0, 6)) {
    console.log(`    [${kind}] - ${before.slice(0, 90)}`);
    console.log(`               + ${after.slice(0, 90)}`);
  }
}

// 二次幂等：对已处理结果再跑一次，应当完全不变
let notIdempotent = 0;
for (const [, , after] of changed) {
  if (replacer.apply(after).text !== after) notIdempotent += 1;
}
console.log(`  幂等性: ${notIdempotent === 0 ? "OK 二次运行零变化" : `! ${notIdempotent} 条二次运行仍在变`}`);

// 路径/URL 保护检查（agx 规则最容易误伤）
const pathCases = [
  "capswriter-agx-client 仓库",
  "~/github/capswriter-agx-client",
  "https://github.com/redyuan43/capswriter-agx-client",
  "GitHubDesktop 客户端",
  "v1.0.22 版本",
  "第2个 192.168.31.134",
];
console.log(`\n--- 边界用例 ---`);
for (const c of pathCases) {
  const out = replacer.apply(c).text;
  console.log(`  ${out === c ? "不动 " : "改动 "} ${c}${out === c ? "" : `  →  ${out}`}`);
}
