// Real nx6 -> ai replay. This does not paste, mutate production history, or
// enable a model. Input already contains ASR text: audio/ASR time is excluded.
const fs = require('fs');
const { AiNaturalFormatter, PROMPT } = require('../src/helpers/aiNaturalFormatter');
const { SpeechJobs } = require('../src/helpers/speechJobs');
const [input, output, promptFile] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node scripts/evaluate-ai-natural.cjs input.json output.jsonl [experimental-prompt.txt]');
const cases = JSON.parse(fs.readFileSync(input, 'utf8'));
const formatter = new AiNaturalFormatter();
const prompt = promptFile ? fs.readFileSync(promptFile, 'utf8').trim() : PROMPT;
const preset = promptFile?.endsWith('.json') ? JSON.parse(prompt) : null;
const generate = formatter.generate.bind(formatter);
formatter.generate = (messages, options) => {
  if (options.json) return generate(messages, options);
  if (preset) {
    const transcript = JSON.parse(messages[1].content).transcript;
    return generate(preset.messages.map(m => ({ ...m, content: m.content.replaceAll('{{CAPS_TRANSCRIPT}}', transcript) })), options);
  }
  return generate([{ ...messages[0], content: prompt }, ...messages.slice(1)], options);
};
const done = new Set(fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).id) : []);
(async () => {
  const probe = await formatter.probe();
  if (!probe.verified) throw Error(`Service unavailable: ${probe.error}`);
  for (const sample of cases) {
    if (done.has(sample.id)) continue;
    const records = new Map();
    const database = {
      createSpeechRecord(id, text) { const row = { id, raw_text: text }; records.set(id, row); return row; },
      updateSpeechRecord(id, update) { if (records.has(id)) Object.assign(records.get(id), update); },
      getTranscriptionById(id) { return records.get(id); }, markSpeechDelivery() {},
    };
    const base = sample.base || sample.raw || sample.raw_text;
    const jobs = new SpeechJobs({ database, approved: () => true,
      polisher: { naturalFormatter: formatter, polish: async () => ({ text: base, stages: [], corrected_text: base }) } });
    // stop == ASR-ready only for this replay. Not a measured key-release time.
    const start = Date.now();
    const front = await jobs.run(base, { sessionId: sample.id, stoppedAtMs: start }, 'replay');
    const foregroundMs = Date.now() - start;
    const result = await jobs.jobs.get(sample.id).work;
    const meta = JSON.parse(records.get(sample.id).processing_json || '{}');
    const row = { ...sample, ...meta, id: sample.id, base, output: result.candidate_text || result.text,
      accepted_text: result.text, frontend_text: front.text, frontend_degraded: front.degraded,
      text_ready_to_delivery_ms: foregroundMs, replay_includes_asr: false,
      prompt_sha256: require('crypto').createHash('sha256').update(prompt).digest('hex'),
      experimental_prompt: !!promptFile };
    if (preset) row.prompt_source = preset.source;
    fs.appendFileSync(output, JSON.stringify(row)+'\n');
    console.log(JSON.stringify({ id: row.id, ms: row.elapsed_ms, gen: row.generation_ms, verify: row.verification_ms,
      changed: row.output !== base, accepted: !row.degraded, foreground: foregroundMs }));
    jobs.dispose();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
