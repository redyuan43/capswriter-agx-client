const { registerClipboardHandlers } = require("./clipboardHandlers");
const { registerDatabaseHandlers } = require("./databaseHandlers");
const { registerDeviceMappingHandlers } = require("./deviceMappingHandlers");
const { registerM5BridgeHandlers } = require("./m5BridgeHandlers");
const { registerKnobMapperHandlers } = require("./knobMapperHandlers");
const { registerMiscHandlers } = require("./miscHandlers");
const { registerSettingsHandlers } = require("./settingsHandlers");
const { registerAsrConnectionHandlers } = require("./asrConnectionHandlers");
const { registerVoiceDatasetHandlers } = require("./voiceDatasetHandlers");
const { registerTextPolishHandlers } = require("./textPolishHandlers");
const { registerWindowHandlers } = require("./windowHandlers");

function registerIpcHandlers(ctx) {
  registerSettingsHandlers(ctx);
  registerAsrConnectionHandlers(ctx);
  registerDatabaseHandlers(ctx);
  registerDeviceMappingHandlers(ctx);
  registerM5BridgeHandlers(ctx);
  registerKnobMapperHandlers(ctx);
  registerClipboardHandlers(ctx);
  registerWindowHandlers(ctx);
  registerMiscHandlers(ctx);
  registerVoiceDatasetHandlers(ctx);
  registerTextPolishHandlers(ctx);
}

module.exports = { registerIpcHandlers };
