// Use only synthetic/non-private fixtures: this command sends audio to Tencent.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { MainRealtimeAsrSession } = require('../../src/helpers/mainRealtimeAsrSession');

async function main() {
  const [url, fixture, countArg = '20', concurrencyArg = '2'] = process.argv.slice(2);
  if (!url || !fixture) throw new Error('Usage: node smoke-client.cjs ws://host/api/asr/realtime synthetic.wav [count] [concurrency]');
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', fixture, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 100 * 1024 * 1024 });
  if (decoded.status !== 0) throw new Error('Fixture decoding failed');
  const pcm = decoded.stdout;
  const count = Number(countArg), concurrency = Number(concurrencyArg);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      const index = next++;
      const requested = performance.now();
      let first = null, audioStarted = null, engine = null;
      const session = new MainRealtimeAsrSession({
        connectionProvider: async () => ({ url, token: '' }),
        onEvent: event => {
          if (event.type === 'ready') engine = event.engine;
          if (event.type === 'partial' && event.text && first === null) first = performance.now();
        },
      });
      try {
        await session.start();
        audioStarted = performance.now();
        for (let offset = 0; offset < pcm.length; offset += 6400) {
          await sleep(Math.max(0, audioStarted + offset / 32 - performance.now()));
          session.sendPcm(pcm.subarray(offset, offset + 6400));
        }
        await sleep(Math.max(0, audioStarted + pcm.length / 32 - performance.now()));
        const finished = performance.now();
        const result = await session.finish();
        const row = { index, engine, readyMs: Math.round(audioStarted - requested),
          firstTextMs: first === null ? null : Math.round(first - requested),
          audioToFirstMs: first === null ? null : Math.round(first - audioStarted),
          finalMs: Math.round(performance.now() - finished),
          partialFallback: result.partial_fallback === true,
          text: result.text, audioSeconds: pcm.length / 32000 };
        results.push(row);
        console.log(JSON.stringify(row));
      } catch (error) {
        session.cancel();
        results.push({ index, error: error.message });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const p95 = field => {
    const values = results.map(r => r[field]).filter(Number.isFinite).sort((a, b) => a - b);
    return values[Math.ceil(values.length * .95) - 1] ?? null;
  };
  const summary = { count: results.length, errors: results.filter(r => r.error).length,
    partialFallbacks: results.filter(r => r.partialFallback).length,
    firstTextP95: p95('firstTextMs'), finalP95: p95('finalMs'),
    nonempty: results.filter(r => r.text).length };
  console.log(JSON.stringify({ summary }));
  if (process.env.ASR_REPORT_PATH) fs.writeFileSync(process.env.ASR_REPORT_PATH, JSON.stringify({ summary, results }, null, 2));
  if (summary.errors || summary.partialFallbacks || summary.nonempty !== count || summary.firstTextP95 > 3000 || summary.finalP95 > 2000) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
