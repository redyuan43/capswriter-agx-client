class M5VoiceBridgeRouter {
  constructor(bridge) {
    this.bridge = bridge;
  }

  async handle(req, res, url) {
    const { bridge } = this;
    const path = url.pathname;

    if (req.method === "GET") {
      if (path === "/health") {
        bridge.requireToken(req);
        bridge.sendJson(res, 200, bridge.healthPayload());
        return;
      }
      if (path === "/state") {
        bridge.sendJson(res, 200, bridge.buildState());
        return;
      }
      if (path === "/devices") {
        bridge.sendJson(res, 200, { devices: bridge.listDevices() });
        return;
      }
      if (path === "/audio/routing") {
        bridge.sendJson(res, 200, {
          success: true,
          routing: bridge.getAudioRoutingState(),
        });
        return;
      }
      if (path === "/device/commands/poll") {
        bridge.requireToken(req);
        await bridge.handleDeviceCommandPoll(req, res, url);
        return;
      }
      if (path === "/" || path === "/dashboard") {
        bridge.sendHtml(res, 200, bridge.buildDashboardHtml());
        return;
      }
      if (path === "/ota/manifest") {
        bridge.handleOtaManifest(res, url);
        return;
      }
      if (path === "/ota/bin") {
        bridge.handleOtaBinary(res, url);
        return;
      }
      if (path === "/recording/tts") {
        bridge.handleRecordingTts(res);
        return;
      }
      if (path === "/recording/source") {
        bridge.handleRecordingSource(res, url);
        return;
      }
    }

    if (req.method !== "POST") {
      bridge.sendJson(res, 405, { success: false, error: "method not allowed" });
      return;
    }

    bridge.requireToken(req, { allowLoopback: path === "/audio/routing" });
    if (path === "/event" || path === "/quota/refresh") {
      await bridge.handleEvent(req, res);
      return;
    }
    if (path === "/recording/start") {
      await bridge.handleRecordingStart(req, res);
      return;
    }
    if (path === "/recording/audio") {
      await bridge.handleRecordingAudio(req, res, url);
      return;
    }
    if (path === "/recording/stop") {
      await bridge.handleRecordingStop(req, res);
      return;
    }
    if (path === "/audio/routing") {
      await bridge.handleAudioRoutingUpdate(req, res);
      return;
    }
    if (path === "/device/commands/ack") {
      await bridge.handleDeviceCommandAck(req, res);
      return;
    }
    bridge.sendJson(res, 404, { success: false, error: "not found" });
  }
}

module.exports = M5VoiceBridgeRouter;
