const PROFILE_SETTING_KEY = "device_mapping_profiles_v1";
const PROFILE_VERSION = 1;
const CARDPUTER_BOARD = "cardputer_adv";
const DEFAULT_CARDPUTER_ID = "28:84:85:76:25:c0";
const WHEEL_ACTION_INTERVAL_MS = 120;

const CONTROL_IDS = Object.freeze([
  "cardputer.opt.tap",
  "cardputer.opt.double",
  "cardputer.opt.hold",
  "cardputer.pointer.primary",
  "cardputer.pointer.secondary",
  "cardputer.pointer.wheel_up",
  "cardputer.pointer.wheel_down",
]);

const DEFAULT_CONTROLS = Object.freeze({
  "cardputer.opt.tap": { type: "device.recording.toggle" },
  "cardputer.opt.double": { type: "device.legacy_double" },
  "cardputer.opt.hold": { type: "device.recording.hold" },
  "cardputer.pointer.primary": { type: "pointer.button", button: "left" },
  "cardputer.pointer.secondary": { type: "pointer.button", button: "right" },
  "cardputer.pointer.wheel_up": { type: "pointer.scroll", direction: "up" },
  "cardputer.pointer.wheel_down": { type: "pointer.scroll", direction: "down" },
});

const DEFAULT_AIR_MOUSE = Object.freeze({
  invert_horizontal: false,
  invert_vertical: false,
  invert_scroll: false,
  pointer_speed: 1.0,
  wheel_speed: 1.0,
  pointer_deadzone_dps: 2.5,
  wheel_deadzone_dps: 5.0,
});

const POINTER_BUTTON_BITS = Object.freeze({
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
});

function cleanDeviceId(value) {
  return String(value || "").trim().toLowerCase();
}

function numberInRange(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : fallback;
}

function normalizeAction(value, fallback = { type: "none" }) {
  const action = value && typeof value === "object" ? value : fallback;
  const type = String(action.type || fallback.type || "none");
  if (type === "pointer.button" && POINTER_BUTTON_BITS[action.button]) {
    return { type, button: action.button };
  }
  if (type === "pointer.scroll" && ["up", "down"].includes(action.direction)) {
    return { type, direction: action.direction };
  }
  if (type === "keyboard.chord") {
    const keys = Array.isArray(action.keys)
      ? action.keys.map((key) => Number(key)).filter((key) => Number.isInteger(key) && key > 0 && key < 768).slice(0, 8)
      : [];
    return keys.length ? { type, behavior: action.behavior === "hold" ? "hold" : "tap", keys } : fallback;
  }
  if ([
    "none",
    "capswriter.dictation.hold",
    "capswriter.dictation.toggle",
    "capswriter.codex.hold",
    "capswriter.codex.toggle",
    "capswriter.cancel",
    "capswriter.confirm",
    "device.recording.toggle",
    "device.recording.hold",
    "device.legacy_double",
  ].includes(type)) {
    return { type };
  }
  return { ...fallback };
}

function defaultProfile(deviceId = DEFAULT_CARDPUTER_ID) {
  return {
    version: PROFILE_VERSION,
    revision: 1,
    board: CARDPUTER_BOARD,
    device_id: cleanDeviceId(deviceId),
    controls: Object.fromEntries(
      CONTROL_IDS.map((id) => [id, { ...DEFAULT_CONTROLS[id] }])
    ),
    air_mouse: { ...DEFAULT_AIR_MOUSE },
  };
}

function normalizeProfile(value, deviceId = DEFAULT_CARDPUTER_ID) {
  const source = value && typeof value === "object" ? value : {};
  const fallback = defaultProfile(deviceId);
  const controls = {};
  for (const id of CONTROL_IDS) {
    const action = normalizeAction(source.controls?.[id], fallback.controls[id]);
    const pointerButton = id.endsWith("pointer.primary") || id.endsWith("pointer.secondary");
    const wheel = id.includes("pointer.wheel_");
    const deviceActionValid =
      (id === "cardputer.opt.tap" && action.type === "device.recording.toggle") ||
      (id === "cardputer.opt.double" && ["device.recording.toggle", "device.legacy_double"].includes(action.type)) ||
      (id === "cardputer.opt.hold" && action.type === "device.recording.hold");
    const incompatible =
      (action.type.startsWith("device.") && !deviceActionValid) ||
      (action.type === "pointer.button" && !pointerButton) ||
      (action.type === "pointer.scroll" && !wheel) ||
      (action.type.endsWith(".hold") && !(pointerButton || id === "cardputer.opt.hold"));
    controls[id] = incompatible ? { ...fallback.controls[id] } : action;
  }
  return {
    version: PROFILE_VERSION,
    revision: Math.max(1, Number.isSafeInteger(source.revision) ? source.revision : 1),
    board: CARDPUTER_BOARD,
    device_id: cleanDeviceId(deviceId || source.device_id || DEFAULT_CARDPUTER_ID),
    controls,
    air_mouse: {
      invert_horizontal: source.air_mouse?.invert_horizontal === true,
      invert_vertical: source.air_mouse?.invert_vertical === true,
      invert_scroll: source.air_mouse?.invert_scroll === true,
      pointer_speed: numberInRange(source.air_mouse?.pointer_speed, 0.5, 2.5, 1.0),
      wheel_speed: numberInRange(source.air_mouse?.wheel_speed, 0.5, 2.0, 1.0),
      pointer_deadzone_dps: numberInRange(source.air_mouse?.pointer_deadzone_dps, 1.0, 6.0, 2.5),
      wheel_deadzone_dps: numberInRange(source.air_mouse?.wheel_deadzone_dps, 2.0, 10.0, 5.0),
    },
  };
}

class DeviceMappingService {
  constructor({ databaseManager, logger = null, commandBroker = null, now = Date.now } = {}) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    this.commandBroker = commandBroker;
    this.now = now;
    this.actionExecutor = null;
    this.keyboardEmitter = null;
    this.inputEventState = new Map();
    this.lastWheelActionAt = new Map();
    this.syncState = new Map();
  }

  setActionExecutor(executor) {
    this.actionExecutor = typeof executor === "function" ? executor : null;
  }

  setKeyboardEmitter(emitter) {
    this.keyboardEmitter = typeof emitter === "function" ? emitter : null;
  }

  _storedProfiles() {
    const stored = this.databaseManager?.getSetting?.(PROFILE_SETTING_KEY, {});
    return stored && typeof stored === "object" ? stored : {};
  }

  getProfile(deviceId = DEFAULT_CARDPUTER_ID) {
    const id = cleanDeviceId(deviceId) || DEFAULT_CARDPUTER_ID;
    return normalizeProfile(this._storedProfiles()[id], id);
  }

  saveProfile(deviceId, profile) {
    const id = cleanDeviceId(deviceId) || DEFAULT_CARDPUTER_ID;
    const previous = this.getProfile(id);
    const normalized = normalizeProfile(profile, id);
    normalized.revision = Math.max(previous.revision + 1, normalized.revision + 1);
    const profiles = this._storedProfiles();
    profiles[id] = normalized;
    this.databaseManager?.setSetting?.(PROFILE_SETTING_KEY, profiles);
    return normalized;
  }

  resetProfile(deviceId) {
    const id = cleanDeviceId(deviceId) || DEFAULT_CARDPUTER_ID;
    const profile = defaultProfile(id);
    profile.revision = this.getProfile(id).revision + 1;
    const profiles = this._storedProfiles();
    profiles[id] = profile;
    this.databaseManager?.setSetting?.(PROFILE_SETTING_KEY, profiles);
    return profile;
  }

  _deviceRoutes(profile) {
    const routeFor = (control) => {
      const type = profile.controls[control]?.type || "none";
      return type.startsWith("device.") ? type : type === "none" ? "none" : "host";
    };
    return {
      opt_tap: routeFor("cardputer.opt.tap"),
      opt_double: routeFor("cardputer.opt.double"),
      opt_hold: routeFor("cardputer.opt.hold"),
    };
  }

  applyProfile(deviceId, profile = null) {
    const id = cleanDeviceId(deviceId) || DEFAULT_CARDPUTER_ID;
    const saved = profile ? this.saveProfile(id, profile) : this.getProfile(id);
    const command = this.commandBroker?.enqueue?.(id, {
      type: "input_profile_update",
      payload: {
        session_id: `profile-${saved.revision}`,
        profile_revision: saved.revision,
        opt_routes: this._deviceRoutes(saved),
        air_mouse: saved.air_mouse,
      },
    });
    this.syncState.set(id, {
      status: command ? "pending" : "saved",
      revision: saved.revision,
      command_id: command?.command_id || "",
    });
    return { success: true, profile: saved, sync: this.syncState.get(id) };
  }

  acknowledgeProfile(deviceId, acknowledgement) {
    const id = cleanDeviceId(deviceId);
    const sync = this.syncState.get(id);
    if (sync && sync.command_id === acknowledgement?.command_id) {
      this.syncState.set(id, {
        ...sync,
        status: acknowledgement.status === "completed" ? "applied" : "failed",
        error: acknowledgement.error || "",
      });
    }
  }

  getStatus(deviceId = DEFAULT_CARDPUTER_ID) {
    const id = cleanDeviceId(deviceId) || DEFAULT_CARDPUTER_ID;
    return {
      success: true,
      supported: process.platform === "linux",
      device_id: id,
      profile: this.getProfile(id),
      sync: this.syncState.get(id) || { status: "saved", revision: this.getProfile(id).revision },
      controls: CONTROL_IDS,
    };
  }

  ensureDeviceProfile(device) {
    if (device?.board !== CARDPUTER_BOARD) return;
    const id = cleanDeviceId(device.device_id);
    const profile = this.getProfile(id);
    const observed = Number(device.input_profile_revision || 0);
    // Old firmware does not advertise profile support. Avoid re-queuing the
    // same command after every legacy device request.
    if (observed <= 0) return;
    if (observed === profile.revision) {
      this.syncState.set(id, { status: "applied", revision: profile.revision });
      return;
    }
    const sync = this.syncState.get(id);
    if (sync?.status === "pending" && sync.revision === profile.revision) return;
    this.applyProfile(id);
  }

  async executeAction(deviceId, action, phase = "press", context = {}) {
    const normalized = normalizeAction(action);
    if (normalized.type === "none") return { handled: true };
    const stateful = (normalized.type === "keyboard.chord" &&
      normalized.behavior === "hold") || normalized.type.endsWith(".hold");
    if (phase === "release" && !stateful) return { handled: true };
    if (normalized.type === "keyboard.chord") {
      await this.keyboardEmitter?.(normalized.keys, normalized.behavior === "hold" ? phase : "tap");
      return { handled: Boolean(this.keyboardEmitter) };
    }
    if (normalized.type.startsWith("capswriter.")) {
      return this.actionExecutor
        ? this.actionExecutor(normalized, phase, { deviceId, ...context })
        : { handled: false, error: "CapsWriter action executor unavailable" };
    }
    return { handled: normalized.type.startsWith("device.") };
  }

  async handleInputEvent(device, body) {
    const deviceId = cleanDeviceId(device?.device_id);
    const control = String(body?.control || "");
    const phase = String(body?.phase || "press");
    const sessionId = String(body?.session_id || "");
    const sequence = Number(body?.sequence);
    if (device?.board !== CARDPUTER_BOARD || deviceId !== DEFAULT_CARDPUTER_ID ||
        body?.protocol_version !== PROFILE_VERSION ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(sessionId) ||
        !Number.isSafeInteger(sequence) || sequence < 0 ||
        !CONTROL_IDS.includes(control) ||
        !["press", "release", "trigger"].includes(phase)) {
      throw Object.assign(new Error("invalid mapped input event"), { statusCode: 400 });
    }
    const previous = this.inputEventState.get(deviceId);
    if (previous?.sessionId === sessionId && sequence <= previous.sequence) {
      return { success: true, duplicate: true, control, phase };
    }
    this.inputEventState.set(deviceId, { sessionId, sequence });
    const action = this.getProfile(deviceId).controls[control];
    const result = await this.executeAction(deviceId, action, phase, { control });
    return { success: true, duplicate: false, control, phase, action: action.type, ...result };
  }

  _nativePointerButton(action) {
    return action?.type === "pointer.button" ? POINTER_BUTTON_BITS[action.button] || 0 : 0;
  }

  async transformPointerReport(deviceId, report, previousButtons = 0) {
    const id = cleanDeviceId(deviceId);
    const profile = this.getProfile(id);
    let buttons = 0;
    const sources = [
      [1, "cardputer.pointer.primary"],
      [2, "cardputer.pointer.secondary"],
    ];
    for (const [sourceBit, control] of sources) {
      const action = profile.controls[control];
      const pressed = Boolean(report.buttons & sourceBit);
      const wasPressed = Boolean(previousButtons & sourceBit);
      const nativeBit = this._nativePointerButton(action);
      if (pressed && nativeBit) buttons |= nativeBit;
      if (pressed !== wasPressed && !nativeBit) {
        await this.executeAction(id, action, pressed ? "press" : "release", { control });
      }
    }

    let wheel = 0;
    if (report.wheel) {
      const direction = report.wheel > 0 ? "up" : "down";
      const control = `cardputer.pointer.wheel_${direction}`;
      const action = profile.controls[control];
      if (action?.type === "pointer.scroll") {
        const outputSign = action.direction === "up" ? 1 : -1;
        wheel = outputSign * Math.abs(report.wheel);
      } else {
        const last = this.lastWheelActionAt.get(`${id}:${control}`) || 0;
        if (this.now() - last >= WHEEL_ACTION_INTERVAL_MS) {
          this.lastWheelActionAt.set(`${id}:${control}`, this.now());
          await this.executeAction(id, action, "trigger", { control });
        }
      }
    }
    return { dx: report.dx, dy: report.dy, wheel, buttons };
  }
}

module.exports = {
  CARDPUTER_BOARD,
  CONTROL_IDS,
  DEFAULT_AIR_MOUSE,
  DEFAULT_CARDPUTER_ID,
  DEFAULT_CONTROLS,
  DeviceMappingService,
  PROFILE_SETTING_KEY,
  PROFILE_VERSION,
  defaultProfile,
  normalizeAction,
  normalizeProfile,
};
