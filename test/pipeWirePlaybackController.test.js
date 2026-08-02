const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const PipeWirePlaybackController = require("../src/helpers/pipeWirePlaybackController");

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = "";
  child.kill = (signal) => {
    child.killedWith = signal;
  };
  return child;
}

test("PipeWire playback decodes audio and targets the configured sink", async () => {
  const calls = [];
  const player = fakeChild();
  const decoder = fakeChild();
  const controller = new PipeWirePlaybackController({
    spawnProcess(command, args) {
      calls.push({ command, args });
      return calls.length === 1 ? player : decoder;
    },
  });
  const played = [];
  player.stdin.on("data", (chunk) => played.push(Buffer.from(chunk)));

  const resultPromise = controller.play(Buffer.from("encoded"), {
    sinkNodeName: "alsa_output.usb-mi-speaker",
    requestId: "tts-a",
  });
  decoder.stdout.write(Buffer.from([1, 2, 3, 4]));
  decoder.stdout.end();
  decoder.emit("close", 0);
  player.emit("close", 0);

  const result = await resultPromise;
  assert.equal(calls[0].command, "pw-play");
  assert.ok(calls[0].args.includes("alsa_output.usb-mi-speaker"));
  assert.deepEqual(Buffer.concat(played), Buffer.from([1, 2, 3, 4]));
  assert.equal(result.request_id, "tts-a");
});

test("PipeWire playback stops both decoder and player", () => {
  const children = [fakeChild(), fakeChild()];
  const controller = new PipeWirePlaybackController({
    spawnProcess() {
      return children.shift();
    },
  });
  controller.play(Buffer.from("encoded"), {
    sinkNodeName: "alsa_output.usb-mi-speaker",
  }).catch(() => {});
  const current = controller.current;

  assert.equal(controller.stop("test"), true);
  assert.equal(current.player.killedWith, "SIGTERM");
  assert.equal(current.decoder.killedWith, "SIGTERM");
});
