const { protectedSpans } = require('./protectedText');

const compact = text => String(text).replace(/[\s\p{P}\p{S}]/gu, '');
const unique = values => [...new Set(values)].sort();
const sameSet = (a, b) => JSON.stringify(unique(a)) === JSON.stringify(unique(b));
function preservesOccurrences(original, before, after) {
  if (!sameSet(before, after)) return false;
  const source = compact(original);
  return unique(before).every(value => {
    const a = before.filter(v => v === value).length, b = after.filter(v => v === value).length;
    if (a === b) return true;
    if (b > a) return false;
    // Removing an occurrence needs literal repeated context in the source, not
    // merely another use of the same word somewhere else (e.g. two 应该 clauses).
    const needle = compact(value), contexts = [], leftContexts = [], centered = [];
    if (!needle) return false;
    let start = source.indexOf(needle);
    while (start >= 0) {
      const context = source.slice(start, start + needle.length + 8);
      contexts.push(context.length === needle.length + 8 ? context : null);
      leftContexts.push(start >= 8 ? source.slice(start - 8, start + needle.length) : null);
      centered.push(start >= 4 && start + needle.length + 4 <= source.length
        ? source.slice(start - 4, start + needle.length + 4) : null);
      start = source.indexOf(needle, start + needle.length);
    }
    return [contexts, leftContexts, centered].some(list => list.every(Boolean) && list.length > new Set(list).size && new Set(list).size <= b);
  });
}
const markers = text => text.match(/不得|不能|不要|没有|不是|不会|禁止|必须|仅|只|除非|如果|至少|至多|先|再|不|没|未|无|\b(?:not|no|never|without|must|unless|if)\b/gi) || [];
const uncertain = text => text.match(/应该|好像|可能|似乎|大概|大约|也许|或许|不确定|不太确定|说不准/g) || [];
const completed = text => text.match(/(?:已经|已)(?:完成|提交|汇总|整理|修复|修改|部署|执行|切换|删除|上传|保存)/g) || [];
function anchors(text, terms) {
  return [...protectedSpans(text).map(s => s.text),
    ...(text.match(/\b[A-Za-z][A-Za-z0-9_-]*\b/g) || []),
    ...(text.match(/[零〇一二三四五六七八九十百千万两]+(?:毫秒|秒|分钟|小时|天|个|次|兆|字节|元|米|\s*[A-Za-z]+)/g) || []),
    ...terms.filter(term => term && text.includes(term))];
}

// Set comparison only permits a candidate to reach the semantic verifier. It is
// never sufficient for automatic delivery: counts, bindings and order matter.
function screenNatural(original, output, terms = []) {
  if (!output.trim()) return { ok: false, reason: 'empty_output' };
  if (/```|<\/?think>|^(?:整理后|分析过程|纠正后|修改说明)[:：]/i.test(output.trim())) return { ok: false, reason: 'invalid_format' };
  if (!sameSet(anchors(original, terms), anchors(output, terms))) return { ok: false, reason: 'protected_changed' };
  if (!sameSet(markers(original), markers(output))) return { ok: false, reason: 'constraint_changed' };
  if (!preservesOccurrences(original, uncertain(original), uncertain(output))) return { ok: false, reason: 'uncertainty_changed' };
  if (!preservesOccurrences(original, completed(original), completed(output))) return { ok: false, reason: 'completion_claim_changed' };
  const a = compact(original), b = compact(output);
  if (b.length > a.length * 1.25 + 2) return { ok: false, reason: 'size_change' };
  return { ok: true, requiresVerification: a !== b };
}

// Store an actual minimal character edit script, with original UTF-16 offsets,
// for review. This is explanation data, not a proof of semantic equivalence.
function textEdits(original, output) {
  if (original === output) return [];
  if (original.length > 2000 || output.length > 3000) return [{ start: 0, end: original.length, before: original, after: output }];
  const width = output.length + 1;
  const dp = new Uint16Array((original.length + 1) * width);
  for (let i = original.length - 1; i >= 0; i--) {
    for (let j = output.length - 1; j >= 0; j--) {
      dp[i * width + j] = original[i] === output[j] ? 1 + dp[(i + 1) * width + j + 1]
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const edits = []; let i = 0, j = 0, edit = null;
  const flush = () => { if (edit) { edits.push(edit); edit = null; } };
  while (i < original.length || j < output.length) {
    if (i < original.length && j < output.length && original[i] === output[j]) { flush(); i++; j++; continue; }
    edit ||= { start: i, end: i, before: '', after: '' };
    if (i < original.length && (j === output.length || dp[(i + 1) * width + j] >= dp[i * width + j + 1])) {
      edit.before += original[i++]; edit.end = i;
    } else edit.after += output[j++];
  }
  flush(); return edits;
}

module.exports = { screenNatural, textEdits };
