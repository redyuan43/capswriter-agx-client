const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loader = path.resolve(__dirname, '../scripts/lib/asr-runtime-env.sh');

function runLoader(contents, mode = 0o600) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capswriter-asr-env-'));
  const envFile = path.join(directory, 'asr-public.env');
  fs.writeFileSync(envFile, contents, { mode });
  fs.chmodSync(envFile, mode);
  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -e; source "$1"; load_capswriter_asr_runtime_env "$2"; printf "%s|%s|%s" "$CAPSWRITER_REALTIME_ASR_URL" "$CAPSWRITER_REALTIME_ASR_TOKEN" "$CAPSWRITER_REALTIME_ASR_FALLBACK_URL"',
      'bash',
      loader,
      envFile,
    ],
    { encoding: 'utf8' },
  );
  fs.rmSync(directory, { recursive: true, force: true });
  return result;
}

test('ASR environment loader accepts only the three runtime settings from a private file', () => {
  const token = 'test-runtime-secret';
  const result = runLoader([
    '# current device ASR route',
    'CAPSWRITER_REALTIME_ASR_URL=wss://asr.example/realtime',
    `CAPSWRITER_REALTIME_ASR_TOKEN=${token}`,
    'CAPSWRITER_REALTIME_ASR_FALLBACK_URL=ws://agx.example/realtime',
    '',
  ].join('\n'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `wss://asr.example/realtime|${token}|ws://agx.example/realtime`);
  assert.equal(result.stderr, '');
});

test('ASR environment loader rejects group-readable files without printing values', () => {
  const token = 'must-not-appear-in-errors';
  const result = runLoader(`CAPSWRITER_REALTIME_ASR_TOKEN=${token}\n`, 0o640);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readable by group or others/);
  assert.equal(result.stderr.includes(token), false);
});

test('ASR environment loader rejects unknown keys without printing their values', () => {
  const value = 'must-not-appear-in-errors';
  const result = runLoader(`UNSAFE_KEY=${value}\n`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported key/);
  assert.equal(result.stderr.includes(value), false);
});
