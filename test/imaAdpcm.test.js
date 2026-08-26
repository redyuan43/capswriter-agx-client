const assert = require("node:assert/strict");
const test = require("node:test");

const {
  IMA_ADPCM_BLOCK_BYTES,
  IMA_ADPCM_CONTENT_TYPE,
  PCM_BYTES_PER_BLOCK,
  decodeImaAdpcmBlocks,
  decodeVibeAudioBody,
} = require("../src/helpers/imaAdpcm");

function constantBlock(sample) {
  const block = Buffer.alloc(IMA_ADPCM_BLOCK_BYTES);
  block.writeInt16LE(sample, 0);
  return block;
}

test("IMA ADPCM independent blocks decode to PCM16", () => {
  const encoded = Buffer.concat([
    constantBlock(1234),
    constantBlock(-2345),
  ]);
  const pcm = decodeImaAdpcmBlocks(encoded);

  assert.equal(pcm.length, 2 * PCM_BYTES_PER_BLOCK);
  assert.equal(pcm.readInt16LE(0), 1234);
  assert.equal(pcm.readInt16LE(PCM_BYTES_PER_BLOCK - 2), 1234);
  assert.equal(pcm.readInt16LE(PCM_BYTES_PER_BLOCK), -2345);
  assert.equal(pcm.readInt16LE(pcm.length - 2), -2345);
});

test("Vibe audio transport decodes only declared ADPCM bodies", () => {
  const encoded = constantBlock(321);
  const decoded = decodeVibeAudioBody({
    "content-type": IMA_ADPCM_CONTENT_TYPE,
    "x-vibe-stick-audio-sample-rate": "16000",
    "x-vibe-stick-audio-channels": "1",
    "x-vibe-stick-audio-block-samples": "960",
  }, encoded);
  assert.equal(decoded.encoding, "ima-adpcm-v1");
  assert.equal(decoded.wireBytes, IMA_ADPCM_BLOCK_BYTES);
  assert.equal(decoded.audio.length, PCM_BYTES_PER_BLOCK);
  assert.equal(decoded.audio.readInt16LE(0), 321);

  const pcm = Buffer.from([1, 2, 3, 4]);
  assert.equal(decodeVibeAudioBody({}, pcm).audio, pcm);
});

test("IMA ADPCM transport rejects malformed blocks and parameters", () => {
  assert.throws(
    () => decodeImaAdpcmBlocks(Buffer.alloc(IMA_ADPCM_BLOCK_BYTES - 1)),
    /invalid IMA ADPCM block length/
  );
  const invalidIndex = constantBlock(0);
  invalidIndex[2] = 89;
  assert.throws(
    () => decodeImaAdpcmBlocks(invalidIndex),
    /invalid IMA ADPCM step index/
  );
  assert.throws(
    () => decodeVibeAudioBody({
      "x-vibe-stick-audio-encoding": "ima-adpcm-v1",
      "x-vibe-stick-audio-sample-rate": "8000",
    }, constantBlock(0)),
    /unsupported IMA ADPCM audio parameters/
  );
});
