const { ipcMain } = require("electron");

const { registerIpcHandlers } = require("../platform/electron/ipc/registerIpcHandlers");

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.windowManager = managers.windowManager;
    this.hotkeyManager = managers.hotkeyManager;
    this.logger = managers.logger;
    this.voiceDatasetRecorder = managers.voiceDatasetRecorder;
    this.textPolisher = managers.textPolisher;
    this.providerSecrets = managers.providerSecrets;
    this.hotWordsStore = managers.hotWordsStore;
    this.asrConnectionProfiles = managers.asrConnectionProfiles;
    this.m5VoiceBridge = managers.m5VoiceBridge;
    this.knobMapperManager = managers.knobMapperManager;
    this.f2RegisteredSenders = new Set();

    registerIpcHandlers(this);
  }

  emitSettingsUpdate(payload) {
    const windows = [this.windowManager.mainWindow, this.windowManager.settingsWindow];
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send("settings-update", payload);
      }
    }
  }

  async checkAIStatus() {
    const result = await this.textPolisher?.longFormatter?.probe();
    return { ...result, available: result?.available === true, model: 'glm-4.7-flash' };
  }

  removeAllHandlers() {
    ipcMain.removeAllListeners();
  }
}

module.exports = IPCHandlers;
