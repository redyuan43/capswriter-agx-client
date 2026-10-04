// Offline text replay. This never enables delivery or modifies the corpus.
const fs = require('fs');
const crypto = require('crypto');
const { NaturalTextFormatter } = require('../src/helpers/naturalTextFormatter');
const { TextPolisher } = require('../src/platform/electron/textPolish');
const { HotWordsStore } = require('../src/platform/electron/hotWordsStore');
const [input, output, dataDirectory, endpoint = 'http://127.0.0.1:18089/v1/chat/completions'] = process.argv.slice(2);
if (!input || !output || !dataDirectory) throw Error('Usage: evaluate-punctuation.cjs CASES.json OUTPUT.jsonl DATA_DIRECTORY [ENDPOINT]');
const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
const store = new HotWordsStore({ dataDirectory });
const polisher = new TextPolisher({ dataDirectory, hotWordsStore: store });
let rawResponse;
const formatter = new NaturalTextFormatter({ profile: 'qwen-punctuation', endpoint, model: 'capswriter-qwen-compare',
  fetchImpl: async (url, options) => { const response = await fetch(url, options); rawResponse = response.clone().text().catch(() => ''); return response; } });
const done = new Set(fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).id) : []);
(async () => {
  try {
    for (const [index, row] of rows.entries()) {
      if (done.has(row.id)) continue;
      rawResponse = null;
      const base = row.base || (await polisher.polish(row.raw, { mode: 'natural', skipModel: true })).text;
      const result = await formatter.format(base, { segments: row.segments || [], words: row.words || [] });
      let modelOutput = '';
      for (const line of String(await rawResponse || '').split('\n')) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try { modelOutput += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || ''; } catch { /* A timed-out stream can be truncated. */ }
      }
      const saved = { ...row, base, output: result.text, candidate: modelOutput, metadata: { ...result, text: undefined },
        input_sha256: crypto.createHash('sha256').update(base).digest('hex') };
      fs.appendFileSync(output, JSON.stringify(saved) + '\n');
      console.log(JSON.stringify({ index: index + 1, total: rows.length, id: row.id, changed: result.changed, status: result.degraded, ms: result.elapsed_ms }));
    }
  } finally { polisher.dispose(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
