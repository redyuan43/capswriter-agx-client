const { protectedSpans, segmentWithOffsets } = require('./protectedText');

// Only these marks belong to spoken-language layout. Quotes, mathematical
// symbols and code punctuation outside this set remain part of the body.
const LAYOUT = /^[\s，。！？；：、,.!?;:]$/u;
const MARK = /[，。！？；：、,.!?;:]/u;
const CJK = /\p{Script=Han}/u;

function atoms(text) {
  const result = [];
  let offset = 0;
  for (const char of text) {
    if (!LAYOUT.test(char)) result.push({ char, start: offset, end: offset + char.length });
    offset += char.length;
  }
  return result;
}

function body(text) { return atoms(text).map(x => x.char).join(''); }

// LCS only aligns punctuation locations. Candidate letters are NEVER copied.
// This also means a model cannot turn a request into a completion claim or
// replace a technical word while returning otherwise plausible punctuation.
function align(a, b) {
  const width = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] = a[i].char === b[j].char ? 1 + dp[(i + 1) * width + j + 1]
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const matches = new Map();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i].char === b[j].char) { matches.set(i++, j++); }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++;
    else j++;
  }
  return matches;
}

function punctuationFromCandidate(original, candidate) {
  if (!candidate.trim() || /```|<\/?think>|^(?:整理后|纠正后|修改说明)[:：]/i.test(candidate.trim())) {
    return { ok: false, reason: 'invalid_format' };
  }
  const a = atoms(original), b = atoms(candidate);
  if (!a.length || a.length > 2000 || b.length > 2200) return { ok: false, reason: 'input_size' };
  const matching = align(a, b);
  const edits = a.length + b.length - 2 * matching.size;
  if (edits > Math.max(2, Math.floor(a.length * 0.05))) return { ok: false, reason: 'body_rewrite' };
  const protectedRanges = [
    ...protectedSpans(original),
    ...Array.from(original.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g), m => ({ start: m.index, end: m.index + m[0].length })),
  ];
  const words = segmentWithOffsets(original).filter(w => w.word);
  const lostQuestion = (candidate.match(/[？?]/g) || []).length < (original.match(/[？?]/g) || []).length;
  let text = original.slice(0, a[0].start), changes = 0;
  for (let i = 0; i < a.length; i++) {
    text += original.slice(a[i].start, a[i].end);
    const start = a[i].end, end = a[i + 1]?.start ?? original.length;
    const existing = original.slice(start, end);
    let replacement = existing;
    const j = matching.get(i), next = matching.get(i + 1);
    if (j !== undefined && (i === a.length - 1 ? j === b.length - 1 : next === j + 1)) {
      const proposed = candidate.slice(b[j].end, b[j + 1]?.start ?? candidate.length);
      const protectedGap = protectedRanges.some(s => start > s.start && end < s.end || start < s.end && end > s.start);
      const splitWord = !existing && MARK.test(proposed) && words.some(w => start > w.start && start < w.end);
      const latinGap = a[i + 1] && /[\w]/u.test(a[i].char) && /[\w]/u.test(a[i + 1].char);
      // A comma in an existing statement is not evidence for a new question.
      const inventedQuestion = /[？?]/.test(proposed) && /[，,]/.test(existing);
      const removedQuestion = lostQuestion && /[？?]/.test(existing);
      const brokenEnding = i === a.length - 1 && /[。？！?!]/.test(existing) && !/[。？！?!]/.test(proposed);
      const joinedSubjects = /[。！？?!]/.test(existing) && !MARK.test(proposed) &&
        /[的你我他她它]/.test(a[i].char) && /^[你我他她它]$/.test(a[i + 1]?.char || '');
      const lostSubjectBoundary = /[。！？?!]/.test(existing) && !MARK.test(proposed) &&
        /^(?:我|你|他|她|它|我们|你们|他们)(?:是|有|会|要|不|就|可以|希望|觉得|需要)/.test(original.slice(end));
      if (!protectedGap && !splitWord && !latinGap && !inventedQuestion && !removedQuestion && !brokenEnding && !joinedSubjects && !lostSubjectBoundary) {
        replacement = proposed;
        // Preserve existing English/Chinese word spacing; remove only stray
        // Chinese inter-character spaces. Paragraph layout comes from the model.
        if (!MARK.test(proposed) && !/\n/.test(proposed)) {
          replacement = !CJK.test(a[i].char) || (a[i + 1] && !CJK.test(a[i + 1].char))
            ? existing.replace(/[，。！？；：、,.!?;:]/g, '') : '';
        }
      }
    }
    if (replacement !== existing) changes++;
    text += replacement;
  }
  if (body(text) !== body(original)) return { ok: false, reason: 'body_changed' };
  if (JSON.stringify(protectedSpans(text).map(s => s.text)) !== JSON.stringify(protectedSpans(original).map(s => s.text))) {
    return { ok: false, reason: 'protected_changed' };
  }
  const longestClause = s => Math.max(...s.split(/[，。！？；：、,.!?;:\n]/).map(x => body(x).length));
  if (longestClause(text) > 40 && longestClause(text) > longestClause(original) * 1.8) {
    return { ok: false, reason: 'over_merged' };
  }
  return { ok: true, text, changes, discarded_word_edits: edits, body_preserved: true };
}

module.exports = { punctuationFromCandidate, punctuationBody: body };
