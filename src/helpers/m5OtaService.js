const fs = require("fs");
const path = require("path");

const OTA_BOARDS = new Set([
  "sticks3",
  "stickc_plus",
  "stickc_plus_minijoy_bt",
]);

function defaultOtaDir() {
  const repoRoot = path.resolve(__dirname, "../..");
  const candidates = [
    path.resolve(repoRoot, "../VibeStick-multi-bridge/firmware/sticks3/ota"),
    path.resolve(repoRoot, "../VibeStick/firmware/sticks3/ota"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function safeOtaBoard(value) {
  const board = String(value || "").trim();
  return OTA_BOARDS.has(board) ? board : "";
}

function readOtaManifest(otaDir, board) {
  const safeBoard = safeOtaBoard(board);
  if (!safeBoard) {
    return null;
  }
  const manifestPath = path.join(otaDir, `${safeBoard}.json`);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

class M5OtaService {
  constructor({ otaDir = defaultOtaDir() } = {}) {
    this.otaDir = otaDir;
  }

  manifest(boardValue) {
    const board = safeOtaBoard(boardValue);
    if (!board) {
      return { available: false, error: "unknown board" };
    }
    const manifest = readOtaManifest(this.otaDir, board);
    if (!manifest) {
      return { available: false, board };
    }
    return {
      ...manifest,
      available: Boolean(manifest.available ?? true),
      board,
      url: manifest.url || `/ota/bin?board=${board}`,
    };
  }

  binary(boardValue) {
    const board = safeOtaBoard(boardValue);
    const manifest = readOtaManifest(this.otaDir, board);
    if (!board || !manifest) {
      return null;
    }
    const fileName = path.basename(String(manifest.file_name || `${board}.bin`));
    const binaryPath = path.join(this.otaDir, fileName);
    try {
      const stat = fs.statSync(binaryPath);
      if (!stat.isFile()) {
        return null;
      }
      return { binaryPath, size: stat.size };
    } catch {
      return null;
    }
  }
}

module.exports = M5OtaService;
module.exports.defaultOtaDir = defaultOtaDir;
module.exports.safeOtaBoard = safeOtaBoard;
module.exports.readOtaManifest = readOtaManifest;
