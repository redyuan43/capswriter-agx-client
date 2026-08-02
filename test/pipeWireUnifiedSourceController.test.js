const assert = require("node:assert/strict");
const test = require("node:test");

const PipeWireUnifiedSourceController = require("../src/helpers/pipeWireUnifiedSourceController");

test("unified source controller switches system input and output with existing streams", () => {
  const calls = [];
  const controller = new PipeWireUnifiedSourceController({
    runCommand(_command, args) {
      calls.push(args);
      if (args[0] === "-f") {
        if (args.at(-1) === "sinks") {
          return JSON.stringify([{ name: "capswriter_input_bus" }]);
        }
        if (args.at(-1) === "source-outputs") {
          return JSON.stringify([
            { index: 7, owner_module: null, properties: {} },
            { index: 8, owner_module: "42", properties: {} },
            {
              index: 9,
              owner_module: null,
              properties: { "application.name": "CapsWriter_Native_Capture" },
            },
          ]);
        }
        if (args.at(-1) === "sink-inputs") {
          return JSON.stringify([
            { index: 10, owner_module: null, properties: {} },
            { index: 11, owner_module: "43", properties: {} },
          ]);
        }
      }
      if (args[0] === "list") {
        return "11\tmodule-loopback\tsource=old sink=capswriter_input_bus\n";
      }
      return "";
    },
  });

  const result = controller.activate(
    "bluez_input.C8_85_41_68_39_0A.7",
    "alsa_output.usb-mi-speaker"
  );

  assert.equal(result.default_source_name, "bluez_input.C8_85_41_68_39_0A.7");
  assert.equal(result.default_sink_name, "alsa_output.usb-mi-speaker");
  assert.ok(calls.some((args) =>
    args[0] === "set-default-source" &&
    args[1] === "bluez_input.C8_85_41_68_39_0A.7"
  ));
  assert.ok(calls.some((args) =>
    args[0] === "set-default-sink" &&
    args[1] === "alsa_output.usb-mi-speaker"
  ));
  assert.ok(calls.some((args) =>
    args[0] === "move-source-output" &&
    args[1] === "7" &&
    args[2] === "bluez_input.C8_85_41_68_39_0A.7"
  ));
  assert.ok(calls.some((args) =>
    args[0] === "move-sink-input" &&
    args[1] === "10" &&
    args[2] === "alsa_output.usb-mi-speaker"
  ));
  assert.equal(calls.some((args) => args[0] === "move-source-output" && args[1] === "8"), false);
  assert.equal(calls.some((args) => args[0] === "move-source-output" && args[1] === "9"), false);
  assert.ok(calls.some((args) =>
    args.includes("source=bluez_input.C8_85_41_68_39_0A.7")
  ));
  assert.ok(calls.some((args) =>
    args[0] === "unload-module" && args[1] === "11"
  ));
});

test("unified source controller releases its active loopback", () => {
  const calls = [];
  const controller = new PipeWireUnifiedSourceController({
    runCommand(_command, args) {
      calls.push(args);
      if (args[0] === "-f") {
        return JSON.stringify([{ name: "capswriter_input_bus" }]);
      }
      if (args[0] === "list") {
        return "42\tmodule-loopback\tsource=bluez_input.test sink=capswriter_input_bus\n";
      }
      return "";
    },
  });
  controller.activeSource = "bluez_input.test";
  controller.activeSink = "alsa_output.test";

  const result = controller.deactivate();

  assert.deepEqual(result, {
    previous_source_node_name: "bluez_input.test",
    previous_sink_node_name: "alsa_output.test",
  });
  assert.equal(controller.activeSource, "");
  assert.equal(controller.activeSink, "");
  assert.equal(calls.some((args) => args[0] === "set-default-source"), false);
  assert.ok(calls.some((args) =>
    args[0] === "unload-module" && args[1] === "42"
  ));
});
