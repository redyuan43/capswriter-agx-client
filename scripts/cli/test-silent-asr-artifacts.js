#!/usr/bin/env node

const assert = require("assert");

async function run() {
  const {
    isExactSilentASRArtifactText,
    isKnownSilentASRArtifact,
    isKnownSilentASRArtifactWithHotwords
  } = await import("../../src/helpers/silentAsrArtifacts.js");

  const artifact = "思源AI大脑；tailscale；subagent。";

  assert.strictEqual(isExactSilentASRArtifactText(artifact), true);
  assert.strictEqual(isExactSilentASRArtifactText(`  ${artifact}  `), true);
  assert.strictEqual(isKnownSilentASRArtifact(artifact), true);

  assert.strictEqual(isKnownSilentASRArtifact("Qwen3-ASR；realtime_asr。"), true);

  assert.strictEqual(isKnownSilentASRArtifact("思源AI大脑"), false);
  assert.strictEqual(isKnownSilentASRArtifact("tailscale"), false);
  assert.strictEqual(isKnownSilentASRArtifact("subagent"), false);
  assert.strictEqual(isKnownSilentASRArtifact("思源AI大脑；tailscale"), false);
  assert.strictEqual(isKnownSilentASRArtifact("思源AI大脑；tailscale；subagent"), false);
  assert.strictEqual(isKnownSilentASRArtifact("思源AI大脑 tailscale subagent"), false);

  const learnedHotwords = "思源AI大脑\ntailscale\nsubagent\nAGENTS.md";
  assert.strictEqual(
    isKnownSilentASRArtifactWithHotwords(learnedHotwords, "思源AI大脑；tailscale；subagent；AGENTS.md。"),
    true
  );
  assert.strictEqual(
    isKnownSilentASRArtifactWithHotwords(learnedHotwords, "思源AI大脑；tailscale；subagent。"),
    true
  );
  assert.strictEqual(
    isKnownSilentASRArtifactWithHotwords(learnedHotwords, "AGENTS.md"),
    false
  );

  console.log("PASS silent ASR artifacts");
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
