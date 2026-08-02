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
