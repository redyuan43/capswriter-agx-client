const EXACT_SILENT_ASR_ARTIFACTS = new Set([
  "思源AI大脑；tailscale；subagent。"
]);

const LEGACY_NORMALIZED_SILENT_ASR_ARTIFACTS = new Set([
  "qwen3asrrealtimeasr"
]);

function parseHotwordTerms(value) {
  return String(value || "")
    .split(/[\n,;，；、|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDelimitedArtifactText(value) {
  return String(value || "")
    .trim()
    .replace(/[。.!！]+$/g, "")
    .replace(/[\n,;，；、|]+/g, "；")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isExactHotwordEchoArtifactText(value, hotwordText) {
  const terms = parseHotwordTerms(hotwordText);
  if (terms.length < 2) return false;
  const normalizedValue = normalizeDelimitedArtifactText(value);
  if (!normalizedValue) return false;
  const normalizedHotwordEcho = normalizeDelimitedArtifactText(terms.join("；"));
  return normalizedValue === normalizedHotwordEcho;
}

export function normalizeLegacyASRArtifactText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s;；:：,，._-]+/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

export function isExactSilentASRArtifactText(value) {
  return EXACT_SILENT_ASR_ARTIFACTS.has(String(value || "").trim());
}

export function isKnownSilentASRArtifact(...values) {
  return values.some((value) => (
    isExactSilentASRArtifactText(value) ||
    LEGACY_NORMALIZED_SILENT_ASR_ARTIFACTS.has(normalizeLegacyASRArtifactText(value))
  ));
}

export function isKnownSilentASRArtifactWithHotwords(hotwordText, ...values) {
  return values.some((value) => (
    isKnownSilentASRArtifact(value) ||
    isExactHotwordEchoArtifactText(value, hotwordText)
  ));
}
