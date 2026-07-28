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

  assert.equal(calls[0].command, "parec");
  assert.ok(calls[0].args.includes("--rate=16000"));
  assert.ok(calls[0].args.includes("--channels=1"));
  assert.ok(calls[0].args.includes("--format=s16le"));
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
