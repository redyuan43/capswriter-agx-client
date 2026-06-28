const { ipcMain } = require("electron");

function registerVoiceDatasetHandlers(ctx) {
  ipcMain.handle("record-voice-dataset-sample", async (_event, sample = {}) => {
    if (!ctx.voiceDatasetRecorder) {
      return { success: false, error: "voice_dataset_recorder_unavailable" };
    }
    try {
      return await ctx.voiceDatasetRecorder.record(sample);
    } catch (error) {
      ctx.logger?.warn?.("记录客户端语音训练样本失败:", error?.message || error);
      return { success: false, error: error?.message || String(error) };
    }
  });
}

module.exports = { registerVoiceDatasetHandlers };
