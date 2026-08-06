function analyzePcm16le(buffer) {
  const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const sampleCount = Math.floor(pcm.length / 2);
  if (!sampleCount) {
    return {
      sampleCount: 0,
      rms: 0,
      peak: 0,
      range: 0,
      zeroRatio: 1,
      transitionRatio: 0,
      positiveRailRatio: 0,
      negativeRailRatio: 0,
    };
  }

  let sumSquares = 0;
  let peak = 0;
  let minimum = 32767;
  let maximum = -32768;
  let zeroSamples = 0;
  let transitions = 0;
  let positiveRailSamples = 0;
  let negativeRailSamples = 0;
  let previous = null;

  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    minimum = Math.min(minimum, sample);
    maximum = Math.max(maximum, sample);
    if (sample === 0) zeroSamples += 1;
    if (sample >= 32760) positiveRailSamples += 1;
    if (sample <= -32760) negativeRailSamples += 1;
    if (previous !== null && sample !== previous) transitions += 1;
    previous = sample;
  }

  return {
    sampleCount,
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
    range: maximum - minimum,
    zeroRatio: zeroSamples / sampleCount,
    transitionRatio: transitions / Math.max(1, sampleCount - 1),
    positiveRailRatio: positiveRailSamples / sampleCount,
    negativeRailRatio: negativeRailSamples / sampleCount,
  };
}

function classifyPcmTransport(buffer) {
  const metrics = analyzePcm16le(buffer);
  let reason = "";
  if (!metrics.sampleCount) {
    reason = "empty";
  } else if (metrics.peak === 0) {
    reason = "all_zero";
  } else if (metrics.range <= 2 && metrics.transitionRatio <= 0.01) {
    reason = "frozen";
  } else if (
    Math.max(metrics.positiveRailRatio, metrics.negativeRailRatio) >= 0.01 &&
    Math.min(metrics.positiveRailRatio, metrics.negativeRailRatio) <= 0.001
  ) {
    reason = "rail_stuck";
  } else if (metrics.zeroRatio >= 0.9 && metrics.transitionRatio <= 0.15) {
    reason = "sparse_frozen";
  }
  return {
    valid: !reason,
    reason,
    metrics,
  };
}

module.exports = {
  analyzePcm16le,
  classifyPcmTransport,
};
