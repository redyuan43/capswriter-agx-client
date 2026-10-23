// 所有索引都是原文 UTF-16 偏移；分词与匹配不重建原文，避免中英混排丢空格。
const PATTERNS = [
  /```[\s\S]*?```|`[^`\n]+`/g,
  /(?:https?:\/\/|www\.)[^\s<>"'，。！？；、）】]+/gi,
  /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
  /\b[A-Za-z]+['’][A-Za-z]+\b/g,
  /--?[A-Za-z][\w-]*/g,
  /(?:[A-Za-z]:[\\/]|~?\/|\.\.?\/)[^\s<>"'，。！？；、）】]+/g,
  /\b[A-Za-z_][\w]*(?:[._/-][\w-]+)+\b/g,
  /\b[a-z][a-z0-9]*[A-Z][a-z]+\w*\b/g,
  /[+-]?(?:\d+(?:[.,:]\d+)*)(?:\s?(?:%|％|ms|s|MHz|GHz|Hz|GB|MB|KB|mAh|mV|V|W|℃|°C|元|秒|分钟|小时|毫秒|公斤|米))?/g,
];

function protectedSpans(text) {
  const matches = PATTERNS.flatMap((re) => Array.from(String(text).matchAll(re), (m) => ({
    start: m.index, end: m.index + m[0].length, text: m[0],
  }))).sort((a, b) => a.start - b.start || b.end - a.end);
  const spans = [];
  for (const match of matches) {
    const previous = spans.at(-1);
    if (previous && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end);
      previous.text = text.slice(previous.start, previous.end);
    } else spans.push(match);
  }
  return spans;
}

function overlaps(spans, start, end) {
  return spans.some((s) => start < s.end && end > s.start);
}

function segmentWithOffsets(text) {
  return Array.from(new Intl.Segmenter('zh', { granularity: 'word' }).segment(text), (s) => ({
    text: s.segment, start: s.index, end: s.index + s.segment.length, word: !!s.isWordLike,
  }));
}

function preserveProtected(original, output) {
  const a = protectedSpans(original).map((s) => s.text);
  const b = protectedSpans(output).map((s) => s.text);
  return JSON.stringify(a) === JSON.stringify(b);
}

// 只规范显式增强的专名，不把普通词表中的命令名改成大小写敏感的另一写法。
function normalizeTermCase(text, entries) {
  const protectedRanges = protectedSpans(text);
  const candidates = [];
  for (const entry of entries) {
    if (entry.enabled === false || entry.weight !== 100 || !/[A-Za-z]/.test(entry.term || '')) continue;
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of text.matchAll(new RegExp(escaped, 'gi'))) {
      const start = match.index, end = start + match[0].length;
      const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end));
      // 未加反引号的调用、赋值和命令仍按代码保留，不从这些片段猜测专名。
      if (/\b(?:const|let|var|function|class|def|import|export)\s|[=;{}|&<>]|(?:^|\s)--?[A-Za-z]/.test(line) ||
          /^\s*\(/.test(text.slice(end))) continue;
      if (match[0] === entry.term ||
          /[A-Za-z0-9_]/.test(text[start - 1] || '') ||
          /[A-Za-z0-9_]/.test(text[end] || '') ||
          overlaps(protectedRanges, start, end)) continue;
      const context = text.slice(Math.max(0, start - 16), end + 16);
      if ((entry.exclusions || []).some(word => word && context.includes(word))) continue;
      candidates.push({ start, end, text: entry.term, source: match[0] });
    }
  }
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const selected = [];
  for (const match of candidates) if (!overlaps(selected, match.start, match.end)) selected.push(match);
  let result = text;
  for (const match of selected.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, match.start) + match.text + result.slice(match.end);
  }
  return { text: result, matches: selected.reverse() };
}

function applyAliases(text, entries) {
  const protectedRanges = protectedSpans(text);
  const candidates = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    for (const alias of entry.aliases || []) {
      if (!alias || alias === entry.term) continue;
      let start = text.indexOf(alias);
      while (start >= 0) {
        const end = start + alias.length;
        const boundary = !(/[A-Za-z0-9_]/.test(alias[0]) && /[A-Za-z0-9_]/.test(text[start - 1] || '')) &&
          !(/[A-Za-z0-9_]/.test(alias.at(-1)) && /[A-Za-z0-9_]/.test(text[end] || ''));
        const context = text.slice(Math.max(0, start - 16), end + 16);
        if (boundary && !overlaps(protectedRanges, start, end) &&
            !(entry.exclusions || []).some((word) => word && context.includes(word))) {
          candidates.push({ start, end, text: entry.term, alias });
        }
        start = text.indexOf(alias, end);
      }
    }
  }
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const selected = [];
  for (const match of candidates) if (!overlaps(selected, match.start, match.end)) selected.push(match);
  let result = text;
  for (const match of selected.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, match.start) + match.text + result.slice(match.end);
  }
  return { text: result, matches: selected.reverse() };
}

module.exports = { protectedSpans, overlaps, preserveProtected, segmentWithOffsets, applyAliases, normalizeTermCase };
