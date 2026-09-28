// 离线对比文本规则的可证实破坏。ASR 原文不是人工真值，不据此报告识别准确率。
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { HotRuleReplacer } = require('../src/helpers/hotRuleReplace');
const { preserveProtected, protectedSpans } = require('../src/helpers/protectedText');
const root = path.resolve(__dirname, '..');
const metadata = process.argv[2] || path.join(os.homedir(), 'Documents/CapsWriter-Voice-Dataset/metadata.jsonl');
const baselineModule = { exports: {} };
vm.runInNewContext(execFileSync('git', ['show', 'HEAD:src/helpers/hotRuleReplace.js'], { cwd: root, encoding: 'utf8' }), { module: baselineModule });
const oldRules = new baselineModule.exports.HotRuleReplacer();
oldRules.load(execFileSync('git', ['show', 'HEAD:assets/hot-rule.txt'], { cwd: root, encoding: 'utf8' }));
const newRules = new HotRuleReplacer(); newRules.load(fs.readFileSync(path.join(root, 'assets/hot-rule.txt'), 'utf8'));
const report = { records: 0, nonempty: 0, explicitRaw: 0, baselineChanged: 0, currentChanged: 0,
  baselineProtectedSequenceChanges: 0, currentProtectedSequenceChanges: 0,
  baselineLostOriginalSpans: 0, currentLostOriginalSpans: 0, ruleOutputDifferences: 0,
  note: '仅统计原始文本中的路径、数字、标识符等是否被改动；不是 CER/WER 或人工语义评分。' };
for (const line of fs.readFileSync(metadata, 'utf8').split('\n').filter(Boolean)) {
  const sample = JSON.parse(line); report.records++;
  const text = String(sample.raw_asr_text || sample.asr_text || sample.text || '');
  if (!text) continue;
  report.nonempty++;
  if (sample.raw_asr_text || sample.asr_text) report.explicitRaw++;
  const before = oldRules.apply(text).text, after = newRules.apply(text).text;
  report.baselineChanged += before !== text; report.currentChanged += after !== text;
  report.baselineProtectedSequenceChanges += !preserveProtected(text, before);
  report.currentProtectedSequenceChanges += !preserveProtected(text, after);
  // 显式规则可生成 AGENTS.md/Qwen3 等新标识符，单独检查原有片段是否仍逐字保留。
  const lostOriginal = (output) => {
    let cursor = 0;
    for (const span of protectedSpans(text)) {
      const index = output.indexOf(span.text, cursor);
      if (index < 0) return true;
      cursor = index + span.text.length;
    }
    return false;
  };
  report.baselineLostOriginalSpans += lostOriginal(before);
  report.currentLostOriginalSpans += lostOriginal(after);
  report.ruleOutputDifferences += before !== after;
}
const output = path.join(root, 'artifacts/asr-review'); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'corpus-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
