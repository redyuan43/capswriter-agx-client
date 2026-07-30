const { registerClipboardHandlers } = require("./clipboardHandlers");
const { registerDatabaseHandlers } = require("./databaseHandlers");
const { registerLinkBookmarkHandlers } = require("./linkBookmarkHandlers");
const { registerMiscHandlers } = require("./miscHandlers");
const { forwardMonitorEvents, registerProcessMonitorHandlers } = require("./processMonitorHandlers");
const { registerSettingsHandlers } = require("./settingsHandlers");
const { registerAsrConnectionHandlers } = require("./asrConnectionHandlers");
const { registerVoiceDatasetHandlers } = require("./voiceDatasetHandlers");
const { registerWindowHandlers } = require("./windowHandlers");

function registerIpcHandlers(ctx) {
  registerSettingsHandlers(ctx);
  registerAsrConnectionHandlers(ctx);
  registerDatabaseHandlers(ctx);
  registerLinkBookmarkHandlers(ctx);
  registerClipboardHandlers(ctx);
  registerWindowHandlers(ctx);
  registerProcessMonitorHandlers(ctx);
  registerMiscHandlers(ctx);
  registerVoiceDatasetHandlers(ctx);
}

module.exports = { forwardMonitorEvents, registerIpcHandlers };
