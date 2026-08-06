const assert = require("node:assert/strict");
const test = require("node:test");

const {
  analyzePcm16le,
  classifyPcmTransport,
} = require("../src/helpers/pcmSignalQuality");

function pcmFromSamples(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  return pcm;
}

test("PCM transport classifier rejects empty, zero, constant, and sparse frozen streams", () => {
  assert.equal(classifyPcmTransport(Buffer.alloc(0)).reason, "empty");
  assert.equal(classifyPcmTransport(Buffer.alloc(4096)).reason, "all_zero");
  assert.equal(
    classifyPcmTransport(pcmFromSamples(new Array(2048).fill(17))).reason,
    "frozen"
  );
  const sparse = new Array(2048).fill(0);
  for (let index = 0; index < sparse.length; index += 32) sparse[index] = 120;
  assert.equal(classifyPcmTransport(pcmFromSamples(sparse)).reason, "sparse_frozen");
});

test("PCM transport classifier rejects a stream stuck on only one sample rail", () => {
  const samples = Array.from({ length: 6144 }, (_, index) => (index % 23) - 11);
  for (let index = 0; index < 180; index += 1) samples[index * 17] = 32767;
  const quality = classifyPcmTransport(pcmFromSamples(samples));

  assert.equal(quality.reason, "rail_stuck");
  assert.ok(quality.metrics.positiveRailRatio > 0.01);
  assert.equal(quality.metrics.negativeRailRatio, 0);
});

test("PCM transport classifier permits balanced loud clipping", () => {
  const samples = Array.from({ length: 4096 }, (_, index) => {
    if (index % 80 === 0) return 32767;
    if (index % 80 === 40) return -32768;
    return (index % 31) - 15;
  });

  assert.equal(classifyPcmTransport(pcmFromSamples(samples)).valid, true);
});

test("PCM transport classifier accepts quiet changing audio without a volume threshold", () => {
  const quiet = Array.from({ length: 2048 }, (_, index) => (index % 19) - 9);
  const quality = classifyPcmTransport(pcmFromSamples(quiet));

  assert.equal(quality.valid, true);
  assert.equal(quality.reason, "");
  assert.ok(quality.metrics.rms < 10);
  assert.ok(quality.metrics.transitionRatio > 0.9);
});

test("PCM metrics ignore an incomplete trailing byte", () => {
  const metrics = analyzePcm16le(Buffer.from([1, 0, 255]));
  assert.equal(metrics.sampleCount, 1);
  assert.equal(metrics.peak, 1);
});
