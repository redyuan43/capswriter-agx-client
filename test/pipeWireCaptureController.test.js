const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("events");

const PipeWireCaptureController = require("../src/helpers/pipeWireCaptureController");

test("PipeWire capture uses a normalized 16 kHz mono stream", () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => calls.push({ signal });
  const controller = new PipeWireCaptureController({
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  const chunks = [];

  controller.start(
    "session-a",
    "pipewire:alsa_input.usb-example",
    (chunk) => chunks.push(chunk.toString())
  );
  child.stdout.emit("data", Buffer.from("pcm"));

  assert.equal(calls[0].command, "pw-record");
  assert.deepEqual(calls[0].args, [
    "--properties",
    "application.name=CapsWriter_Native_Capture node.name=capswriter_capture_session-a",
    "--target",
    "alsa_input.usb-example",
    "--rate",
    "16000",
    "--channels",
    "1",
    "--format",
    "s16",
    "--latency",
    "40ms",
    "-",
  ]);
  assert.equal(calls[0].options.env.PIPEWIRE_REMOTE, "pipewire-0");
  assert.match(calls[0].options.env.PIPEWIRE_RUNTIME_DIR, /^\/run\/user\/\d+$/);
  assert.match(calls[0].options.env.PULSE_SERVER, /^unix:\/run\/user\/\d+\/pulse\/native$/);
  assert.deepEqual(chunks, ["pcm"]);
  assert.equal(controller.stop("session-a"), true);
  assert.deepEqual(calls[1], { signal: "SIGTERM" });
});

test("PipeWire capture reports only unexpected process exits", () => {
  const children = [];
  const exits = [];
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  controller.start("unexpected", "pipewire:one", () => {}, "", {
    onUnexpectedExit: (details) => exits.push(details),
  });
  children[0].stdout.emit("data", Buffer.from("pcm"));
  children[0].emit("close", 1, null);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sessionId, "unexpected");

  controller.start("intentional", "pipewire:two", () => {}, "", {
    onUnexpectedExit: (details) => exits.push(details),
  });
  controller.stop("intentional");
  children[1].emit("close", null, "SIGTERM");
  assert.equal(exits.length, 1);
});

test("a replaced capture survives the previous process close event", () => {
  const children = [];
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });

  controller.start("same-session", "pipewire:first", () => {});
  controller.start("same-session", "pipewire:second", () => {});
  children[0].emit("error", new Error("old capture failed while stopping"));
  assert.equal(controller.captures.get("same-session").child, children[1]);
  children[0].emit("close", null, "SIGTERM");

  assert.equal(controller.captures.get("same-session").child, children[1]);
  assert.equal(controller.stop("same-session"), true);
});

test("PipeWire capture retries when the first process produces no audio", async () => {
  const children = [];
  const warnings = [];
  const controller = new PipeWireCaptureController({
    firstChunkRetryMs: 10,
    maxStartAttempts: 3,
    logger: {
      warn(message, details) {
        warnings.push({ message, details });
      },
    },
    spawnProcess() {
      const child = new EventEmitter();
      child.pid = children.length + 1;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  const chunks = [];

  controller.start("retry", "pipewire:source", (chunk) => chunks.push(chunk.toString()));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(children.length, 2);
  assert.equal(warnings[0].message, "PipeWire capture produced no audio, retrying");
  children[1].stdout.emit("data", Buffer.from("pcm"));
  assert.deepEqual(chunks, ["pcm"]);
  assert.equal(controller.stop("retry"), true);
});

test("PipeWire capture waits for asynchronous retry preparation before relaunching", async () => {
  const children = [];
  let finishPreparation;
  const preparation = new Promise((resolve) => {
    finishPreparation = resolve;
  });
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.pid = children.length + 1;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });

  controller.start("prepared-retry", "pipewire:source", () => {}, "", {
    firstChunkRetryMs: 10,
    maxStartAttempts: 2,
    beforeRetry: () => preparation,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(children.length, 1);

  finishPreparation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.equal(controller.stop("prepared-retry"), true);
});

test("PipeWire capture validates initial PCM and flushes quiet changing audio", () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const controller = new PipeWireCaptureController({ spawnProcess: () => child });
  const chunks = [];

  controller.start("valid-pcm", "pipewire:source", (chunk) => chunks.push(chunk), "", {
    initialAudioBytes: 8,
    validateInitialAudio: (pcm) => ({
      valid: pcm.some((byte) => byte !== 0),
      reason: "all_zero",
    }),
  });
  child.stdout.emit("data", Buffer.from([1, 0, 2, 0]));
  assert.equal(chunks.length, 0);
  child.stdout.emit("data", Buffer.from([3, 0, 4, 0]));

  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
  assert.equal(controller.stop("valid-pcm"), true);
});

test("PipeWire capture resets the route only after invalid initial PCM", async () => {
  const children = [];
  const retryReasons = [];
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  const chunks = [];
  controller.start("invalid-then-valid", "pipewire:source", (chunk) => chunks.push(chunk), "", {
    initialAudioBytes: 8,
    maxStartAttempts: 2,
    validateInitialAudio: (pcm) => ({
      valid: pcm.some((byte) => byte !== 0),
      reason: "all_zero",
    }),
    beforeRetry: ({ reason }) => retryReasons.push(reason),
  });

  children[0].stdout.emit("data", Buffer.alloc(8));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.deepEqual(retryReasons, ["invalid_audio"]);
  assert.equal(chunks.length, 0);

  children[1].stdout.emit("data", Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
  assert.equal(chunks.length, 1);
  assert.equal(controller.stop("invalid-then-valid"), true);
});

test("PipeWire capture waits through mSBC startup silence and flushes all buffered PCM", () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const controller = new PipeWireCaptureController({ spawnProcess: () => child });
  const chunks = [];
  let retries = 0;

  controller.start("startup-silence", "pipewire:source", (chunk) => chunks.push(chunk), "", {
    initialAudioBytes: 8,
    maxInitialAudioBytes: 16,
    deferredInvalidAudioReasons: ["all_zero"],
    validateInitialAudio: (pcm) => ({
      valid: pcm.some((byte) => byte !== 0),
      reason: "all_zero",
    }),
    beforeRetry: () => { retries += 1; },
  });

  child.stdout.emit("data", Buffer.alloc(8));
  assert.equal(chunks.length, 0);
  assert.equal(retries, 0);
  child.stdout.emit("data", Buffer.from([1, 0, 2, 0]));

  assert.deepEqual(Buffer.concat(chunks), Buffer.from([
    0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0,
  ]));
  assert.equal(retries, 0);
  assert.equal(controller.stop("startup-silence"), true);
});

test("PipeWire capture retries when mSBC startup remains silent through its grace window", async () => {
  const children = [];
  const retries = [];
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });

  controller.start("persistent-silence", "pipewire:source", () => {}, "", {
    initialAudioBytes: 8,
    maxInitialAudioBytes: 16,
    deferredInvalidAudioReasons: ["all_zero"],
    maxStartAttempts: 2,
    validateInitialAudio: () => ({ valid: false, reason: "all_zero" }),
    beforeRetry: (details) => retries.push(details.validationReason),
  });

  children[0].stdout.emit("data", Buffer.alloc(8));
  assert.equal(children.length, 1);
  children[0].stdout.emit("data", Buffer.alloc(8));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(children.length, 2);
  assert.deepEqual(retries, ["all_zero"]);
  assert.equal(controller.stop("persistent-silence"), true);
});

test("PipeWire capture reports invalid PCM after retry exhaustion", async () => {
  const children = [];
  const failures = [];
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  controller.start("always-invalid", "pipewire:source", () => {}, "", {
    initialAudioBytes: 8,
    maxStartAttempts: 2,
    validateInitialAudio: () => ({
      valid: false,
      reason: "all_zero",
      metrics: { peak: 0 },
    }),
    onInvalidAudio: (details) => failures.push(details),
  });

  children[0].stdout.emit("data", Buffer.alloc(8));
  await new Promise((resolve) => setImmediate(resolve));
  children[1].stdout.emit("data", Buffer.alloc(8));

  assert.equal(failures.length, 1);
  assert.equal(failures[0].validationReason, "all_zero");
  assert.equal(failures[0].metrics.peak, 0);
  assert.equal(controller.captures.has("always-invalid"), false);
});

test("PipeWire capture rebuilds the route before retrying an early process exit", async () => {
  const children = [];
  const preparations = [];
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
  });
  controller.start("early-exit", "pipewire:source", () => {}, "", {
    maxStartAttempts: 2,
    beforeRetry: (details) => preparations.push(details),
  });

  children[0].emit("close", 1, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(children.length, 2);
  assert.equal(preparations.length, 1);
  assert.equal(preparations[0].reason, "capture_exited");
  assert.equal(preparations[0].code, 1);
  assert.equal(controller.stop("early-exit"), true);
});
