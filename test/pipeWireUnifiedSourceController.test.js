const assert = require("node:assert/strict");
const test = require("node:test");

const PipeWireUnifiedSourceController = require("../src/helpers/pipeWireUnifiedSourceController");

test("unified source controller replaces its loopback and keeps one default source", () => {
  const calls = [];
  const controller = new PipeWireUnifiedSourceController({
    runCommand(_command, args) {
      calls.push(args);
      if (args[0] === "-f") {
        return JSON.stringify([{ name: "capswriter_input_bus" }]);
      }
      if (args[0] === "list") {
        return "11\tmodule-loopback\tsource=old sink=capswriter_input_bus\n";
      }
      return "";
    },
  });

  controller.activate("bluez_input.C8_85_41_68_39_0A.7");

  assert.deepEqual(calls.at(-1), [
    "set-default-source",
    "capswriter_input_bus.monitor",
  ]);
  assert.ok(calls.some((args) =>
    args.includes("source=bluez_input.C8_85_41_68_39_0A.7")
  ));
  assert.ok(calls.some((args) =>
    args[0] === "unload-module" && args[1] === "11"
  ));
});
