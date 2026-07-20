const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const M5OtaService = require("../src/helpers/m5OtaService");

test("OTA service returns stable manifest and binary metadata", (t) => {
  const otaDir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-ota-"));
  t.after(() => fs.rmSync(otaDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(otaDir, "stickc_plus.json"), JSON.stringify({
    version: "0.1.36",
    file_name: "stickc_plus.bin",
  }));
  fs.writeFileSync(path.join(otaDir, "stickc_plus.bin"), Buffer.from([1, 2, 3]));

  const service = new M5OtaService({ otaDir });
  assert.deepEqual(service.manifest("stickc_plus"), {
    version: "0.1.36",
    file_name: "stickc_plus.bin",
    available: true,
    board: "stickc_plus",
    url: "/ota/bin?board=stickc_plus",
  });
  assert.deepEqual(service.binary("stickc_plus"), {
    binaryPath: path.join(otaDir, "stickc_plus.bin"),
    size: 3,
  });
});

test("OTA service rejects unknown boards and missing images", () => {
  const service = new M5OtaService({ otaDir: "/path/that/does/not/exist" });

  assert.deepEqual(service.manifest("../../stickc_plus"), {
    available: false,
    error: "unknown board",
  });
  assert.deepEqual(service.manifest("sticks3"), {
    available: false,
    board: "sticks3",
  });
  assert.equal(service.binary("../../stickc_plus"), null);
  assert.equal(service.binary("sticks3"), null);
});
