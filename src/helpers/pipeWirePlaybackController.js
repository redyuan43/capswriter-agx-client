const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

class PipeWirePlaybackController {
  constructor({ logger = null, spawnProcess = spawn } = {}) {
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.current = null;
  }

  stop(reason = "replaced") {
    const current = this.current;
    if (!current) return false;
    this.current = null;
    current.reason = reason;
    current.decoder?.kill?.("SIGTERM");
    current.player?.kill?.("SIGTERM");
    return true;
  }

  play(value, { sinkNodeName = "", requestId = `audio-${Date.now()}` } = {}) {
    const audio = Buffer.from(value || []);
    if (!audio.length) {
      return Promise.reject(new Error("Audio playback buffer is empty"));
    }
    const target = String(sinkNodeName || "").trim();
    if (!target) {
      return Promise.reject(new Error("PipeWire output sink is required"));
    }
    this.stop("replaced");

    return new Promise((resolve, reject) => {
      const player = this.spawnProcess("pw-play", [
        "--target",
        target,
        "--rate",
        "48000",
        "--channels",
        "2",
        "--format",
        "s16",
        "--latency",
        "40ms",
        "-",
      ], { stdio: ["pipe", "ignore", "pipe"] });
      const decoder = this.spawnProcess(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      const current = {
        requestId,
        decoder,
        player,
        reason: "",
        decoderError: "",
        playerError: "",
        settled: false,
      };
      this.current = current;

      const finish = (error = null) => {
        if (current.settled) return;
        current.settled = true;
        if (this.current === current) this.current = null;
        if (error) reject(error);
        else resolve({ success: true, request_id: requestId, sink_node_name: target });
      };

      decoder.stderr?.on("data", (chunk) => {
        current.decoderError += chunk.toString();
      });
      player.stderr?.on("data", (chunk) => {
        current.playerError += chunk.toString();
      });
      decoder.on("error", (error) => finish(error));
      player.on("error", (error) => finish(error));
      decoder.stdout.pipe(player.stdin);
      decoder.stdin.end(audio);
      decoder.on("close", (code) => {
        if (code && !current.reason) {
          player.kill?.("SIGTERM");
          finish(new Error(current.decoderError.trim() || `ffmpeg exited with code ${code}`));
        }
      });
      player.on("close", (code) => {
        if (current.reason) {
          finish();
          return;
        }
        if (code) {
          finish(new Error(current.playerError.trim() || `pw-play exited with code ${code}`));
          return;
        }
        finish();
      });
    });
  }
}

module.exports = PipeWirePlaybackController;
