const assert = require("node:assert/strict");
const test = require("node:test");

const {
  shouldUseRendererCapture,
} = require("../src/helpers/hostTriggerCapturePolicy");

test("default keyboard capture stays local while configured routes use the bridge", () => {
  assert.equal(shouldUseRendererCapture("keyboard", true), true);
  assert.equal(shouldUseRendererCapture("keyboard", false), false);
  assert.equal(shouldUseRendererCapture("minijoy_bt:14080852f962", true), false);
});
