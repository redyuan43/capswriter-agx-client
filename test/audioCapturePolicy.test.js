const assert = require("node:assert/strict");
const test = require("node:test");

const policyPromise = import("../src/helpers/audioCapturePolicy.mjs");

test("audio capture profiles always follow the operating system default input", async () => {
  const { buildSystemDefaultAudioCaptureProfiles } = await policyPromise;
  const profiles = buildSystemDefaultAudioCaptureProfiles();

  assert.deepEqual(profiles.map((profile) => profile.name), [
    "system_default",
    "system_default_raw",
  ]);
  assert.equal(profiles[0].constraints.audio, true);
  assert.equal("deviceId" in profiles[1].constraints.audio, false);
  assert.equal(JSON.stringify(profiles).includes("explicit_device"), false);
});

test("audio capture profiles return fresh constraint objects", async () => {
  const { buildSystemDefaultAudioCaptureProfiles } = await policyPromise;
  const first = buildSystemDefaultAudioCaptureProfiles();
  const second = buildSystemDefaultAudioCaptureProfiles();

  assert.notEqual(first, second);
  assert.notEqual(first[1].constraints.audio, second[1].constraints.audio);
});

test("media stream release stops every track", async () => {
  const { stopMediaStreamTracks } = await policyPromise;
  const stopped = [];
  const stream = {
    getTracks: () => [
      { stop: () => stopped.push("audio") },
      { stop: () => stopped.push("aux") },
    ],
  };

  assert.equal(stopMediaStreamTracks(stream), 2);
  assert.deepEqual(stopped, ["audio", "aux"]);
  assert.equal(stopMediaStreamTracks(null), 0);
});
