const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ENABLED_SETTING,
  VERIFIED_MAPPINGS,
  KnobMapperManager,
} = require("../src/helpers/knobMapperManager");

function createManager() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "capswriter-knob-mapper-"));
  const values = new Map([[ENABLED_SETTING, true]]);
  return {
    manager: new KnobMapperManager({
      logger: { info() {}, warn() {} },
      databaseManager: {
        getSetting(key, fallback) {
          return values.has(key) ? values.get(key) : fallback;
        },
        setSetting(key, value) {
          values.set(key, value);
          return { changes: 1 };
        },
      },
      dataDirectory,
    }),
    values,
    dataDirectory,
  };
}

test("verified mappings expose the fixed hardware contract", () => {
  const iine = VERIFIED_MAPPINGS.find((item) => item.id === "iine");
  assert.equal(iine.device, "IINE_keyboard");
  assert.deepEqual(iine.entries[0], ["按键", "KEY_SPACE", "按住 Right Shift"]);
});

test("runtime config is copied into the CapsWriter data directory", () => {
  const { manager, dataDirectory } = createManager();
  const configPath = manager.ensureRuntimeConfig();
  assert.equal(configPath, path.join(dataDirectory, "knob-mapper", "config.yaml"));
  assert.equal(fs.existsSync(configPath), true);
  assert.match(fs.readFileSync(configPath, "utf8"), /IINE_keyboard/);
});

test("setEnabled persists the setting and delegates lifecycle", async () => {
  const { manager, values } = createManager();
  let started = 0;
  let stopped = 0;
  manager.start = async () => {
    started += 1;
    return { success: true };
  };
  manager.stop = async () => {
    stopped += 1;
    return { success: true };
  };

  await manager.setEnabled(false);
  assert.equal(values.get(ENABLED_SETTING), false);
  assert.equal(stopped, 1);

  await manager.setEnabled(true);
  assert.equal(values.get(ENABLED_SETTING), true);
  assert.equal(started, 1);
});
