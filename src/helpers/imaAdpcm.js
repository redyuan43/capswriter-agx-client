const IMA_ADPCM_ENCODING = "ima-adpcm-v1";
const IMA_ADPCM_CONTENT_TYPE = "application/vnd.vibestick.ima-adpcm";
const IMA_ADPCM_BLOCK_SAMPLES = 960;
const IMA_ADPCM_BLOCK_BYTES = 484;
const PCM_BYTES_PER_BLOCK = IMA_ADPCM_BLOCK_SAMPLES * 2;

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34,
  37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
  1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428,
  4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
  29794, 32767,
];
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function requestAudioEncoding(headers = {}) {
  const explicit = String(headers["x-vibe-stick-audio-encoding"] || "")
    .trim()
    .toLowerCase();
  if (explicit) {
    return explicit;
  }
  const contentType = String(headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return contentType === IMA_ADPCM_CONTENT_TYPE
    ? IMA_ADPCM_ENCODING
    : "";
}

function validateTransportHeaders(headers = {}) {
  const sampleRate = String(headers["x-vibe-stick-audio-sample-rate"] || "").trim();
  const channels = String(headers["x-vibe-stick-audio-channels"] || "").trim();
  const blockSamples = String(headers["x-vibe-stick-audio-block-samples"] || "").trim();
  if (sampleRate !== "16000" ||
      channels !== "1" ||
      blockSamples !== String(IMA_ADPCM_BLOCK_SAMPLES)) {
    throw Object.assign(new Error("unsupported IMA ADPCM audio parameters"), {
      statusCode: 415,
    });
  }
}

function decodeImaAdpcmBlocks(input) {
  const encoded = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (encoded.length === 0 || encoded.length % IMA_ADPCM_BLOCK_BYTES !== 0) {
    throw Object.assign(new Error("invalid IMA ADPCM block length"), {
      statusCode: 400,
    });
  }
  const blockCount = encoded.length / IMA_ADPCM_BLOCK_BYTES;
  const pcm = Buffer.allocUnsafe(blockCount * PCM_BYTES_PER_BLOCK);

  for (let block = 0; block < blockCount; block += 1) {
    const inputOffset = block * IMA_ADPCM_BLOCK_BYTES;
    const outputOffset = block * PCM_BYTES_PER_BLOCK;
    let predictor = encoded.readInt16LE(inputOffset);
    let stepIndex = encoded[inputOffset + 2];
    if (stepIndex > 88) {
      throw Object.assign(new Error("invalid IMA ADPCM step index"), {
        statusCode: 400,
      });
    }
    pcm.writeInt16LE(predictor, outputOffset);

    for (let sample = 1; sample < IMA_ADPCM_BLOCK_SAMPLES; sample += 1) {
      const packed = encoded[
        inputOffset + 4 + Math.floor((sample - 1) / 2)
      ];
      const code = sample % 2 === 1 ? packed & 0x0f : packed >> 4;
      const step = STEP_TABLE[stepIndex];
      let delta = step >> 3;
      if (code & 4) delta += step;
      if (code & 2) delta += step >> 1;
      if (code & 1) delta += step >> 2;
      predictor = clamp(
        predictor + ((code & 8) ? -delta : delta),
        -32768,
        32767
      );
      stepIndex = clamp(stepIndex + INDEX_TABLE[code & 7], 0, 88);
      pcm.writeInt16LE(
        predictor,
        outputOffset + sample * 2
      );
    }
  }
  return pcm;
}

function decodeVibeAudioBody(headers, body) {
  const encoding = requestAudioEncoding(headers);
  const wireBody = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (!encoding) {
    return {
      audio: wireBody,
      encoding: "pcm16",
      wireBytes: wireBody.length,
    };
  }
  if (encoding !== IMA_ADPCM_ENCODING) {
    throw Object.assign(new Error(`unsupported audio encoding: ${encoding}`), {
      statusCode: 415,
    });
  }
  validateTransportHeaders(headers);
  return {
    audio: decodeImaAdpcmBlocks(wireBody),
    encoding,
    wireBytes: wireBody.length,
  };
}

module.exports = {
  IMA_ADPCM_BLOCK_BYTES,
  IMA_ADPCM_BLOCK_SAMPLES,
  IMA_ADPCM_CONTENT_TYPE,
  IMA_ADPCM_ENCODING,
  PCM_BYTES_PER_BLOCK,
  decodeImaAdpcmBlocks,
  decodeVibeAudioBody,
  requestAudioEncoding,
};
