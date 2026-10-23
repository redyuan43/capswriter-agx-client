const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter, once } = require("events");
const { spawn } = require("node:child_process");

const PipeWireCaptureController = require("../src/helpers/pipeWireCaptureController");

function drainingCapture(options = {}, captureOptions = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const chunks = [];
  const controller = new PipeWireCaptureController({ spawnProcess: () => child, ...options });
  controller.start("drain", "pipewire:source", (chunk) => chunks.push(chunk), "", captureOptions);
  return { controller, child, chunks, signals };
}

test("draining stop waits for close and preserves PCM emitted after exit", async () => {
  const { controller, child, chunks, signals } = drainingCapture();
  child.stdout.emit("data", Buffer.alloc(4096, 1));
  const stopped = controller.stop("drain", { drain: true });
  assert.equal(controller.stop("drain", { drain: true }), stopped);
  let settled = false;
  stopped.then(() => { settled = true; });
  child.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.emit("data", Buffer.alloc(1600, 2));
  child.emit("close", 0, null);
  assert.equal(await stopped, true);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4096, 1600]);
  assert.deepEqual(signals, ["SIGTERM"]);
  child.stdout.emit("data", Buffer.alloc(32));
  assert.equal(chunks.length, 2);
  assert.equal(await controller.stop("drain", { drain: true }), false);
});

test("cancelling a draining capture settles the wait and rejects late PCM", async () => {
  const { controller, child, chunks, signals } = drainingCapture();
  const stopped = controller.stop("drain", { drain: true });
  assert.equal(controller.stop("drain"), true);
  assert.equal(await stopped, false);
  child.stdout.emit("data", Buffer.alloc(1600));
  child.emit("close", null, "SIGTERM");
  assert.equal(chunks.length, 0);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("draining stop times out, kills the child and rejects further PCM", async () => {
  const { controller, child, chunks, signals } = drainingCapture({ stopTimeoutMs: 10 });
  await assert.rejects(controller.stop("drain", { drain: true }), { code: "PIPEWIRE_CAPTURE_STOP_TIMEOUT" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.stdout.emit("data", Buffer.alloc(1600));
  child.emit("close", null, "SIGKILL");
  assert.equal(chunks.length, 0);
  assert.equal(controller.captures.size, 0);
});

test("draining stop reports process errors and abnormal exits without retrying", async () => {
  for (const failure of ["error", "stdout", "close", "kill", "already-exited", "signal-not-sent"]) {
    const { controller, child } = drainingCapture();
    if (failure === "kill") child.kill = () => { throw new Error("signal failed"); };
    if (failure === "already-exited") child.exitCode = 1;
    if (failure === "signal-not-sent") child.kill = () => false;
    const stopped = controller.stop("drain", { drain: true });
    const rejected = assert.rejects(stopped, /signal failed|capture failed|stopped abnormally/);
    if (failure === "error") child.emit("error", new Error("capture failed"));
    if (failure === "stdout") child.stdout.emit("error", new Error("capture failed"));
    if (failure === "close") child.emit("close", 2, null);
    if (failure === "already-exited" || failure === "signal-not-sent") child.emit("close", 1, null);
    await rejected;
    assert.equal(controller.captures.size, 0);
  }
});

test("spontaneous code 1 exit remains a capture failure", async () => {
  const failures = [];
  const { controller, child } = drainingCapture({}, { onUnexpectedExit: (details) => failures.push(details) });
  child.stdout.emit("data", Buffer.alloc(4096));
  child.emit("close", 1, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 1);
  assert.equal(await controller.stop("drain", { drain: true }), false);
});

test("draining stop accepts pw-record style code 1 and preserves the real child's final write", { timeout: 5000 }, async (t) => {
  let child;
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      child = spawn(process.execPath, ["-e", `
        process.on('SIGTERM', () => {
          process.stdout.end(Buffer.alloc(1600, 2), () => process.exit(1));
        });
        process.stdout.write(Buffer.alloc(4096, 1));
        setInterval(() => {}, 1000);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      return child;
    },
  });
  t.after(() => controller.stopAll());
  const chunks = [];
  let gotFirstChunk;
  const firstChunk = new Promise((resolve) => { gotFirstChunk = resolve; });
  controller.start("real-drain", "pipewire:source", (chunk) => {
    chunks.push(chunk);
    gotFirstChunk();
  });
  await firstChunk;
  const closed = once(child, "close");
  assert.equal(await controller.stop("real-drain", { drain: true }), true);
  assert.deepEqual(await closed, [1, null]);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.alloc(4096, 1), Buffer.alloc(1600, 2)]));
});

test("cancelling drain kills a real child that ignores SIGTERM", { timeout: 5000 }, async (t) => {
  let child;
  const controller = new PipeWireCaptureController({
    spawnProcess() {
      child = spawn(process.execPath, ["-e", `
        process.on('SIGTERM', () => {});
        process.stdout.write(Buffer.alloc(4096));
        setInterval(() => {}, 1000);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      return child;
    },
  });
  t.after(() => child?.kill("SIGKILL"));
  let gotAudio;
  const audio = new Promise((resolve) => { gotAudio = resolve; });
  controller.start("cancel-real", "pipewire:source", () => gotAudio());
  await audio;
  const closed = once(child, "close");
  const stopped = controller.stop("cancel-real", { drain: true });
  controller.stop("cancel-real");
  assert.equal(await stopped, false);
  assert.deepEqual(await closed, [null, "SIGKILL"]);
  assert.equal(controller.captures.size, 0);
});

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
