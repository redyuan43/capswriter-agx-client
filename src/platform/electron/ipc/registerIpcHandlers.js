const { registerClipboardHandlers } = require("./clipboardHandlers");
const { registerDatabaseHandlers } = require("./databaseHandlers");
const { registerM5BridgeHandlers } = require("./m5BridgeHandlers");
const { registerMiscHandlers } = require("./miscHandlers");
const { registerSettingsHandlers } = require("./settingsHandlers");
const { registerAsrConnectionHandlers } = require("./asrConnectionHandlers");
const { registerVoiceDatasetHandlers } = require("./voiceDatasetHandlers");
const { registerWindowHandlers } = require("./windowHandlers");

function registerIpcHandlers(ctx) {
  registerSettingsHandlers(ctx);
  registerAsrConnectionHandlers(ctx);
  registerDatabaseHandlers(ctx);
  registerM5BridgeHandlers(ctx);
  registerClipboardHandlers(ctx);
  registerWindowHandlers(ctx);
  registerMiscHandlers(ctx);
  registerVoiceDatasetHandlers(ctx);
}

module.exports = { registerIpcHandlers };
