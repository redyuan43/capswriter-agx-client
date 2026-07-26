const { randomUUID } = require("crypto");

const DEFAULT_POLL_TIMEOUT_MS = 25000;
const MAX_POLL_TIMEOUT_MS = 30000;
const MAX_COMMANDS_PER_DEVICE = 32;

function clean(value) {
  return String(value || "").trim();
}

class M5DeviceCommandBroker {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.devices = new Map();
  }

  stateFor(deviceId) {
    const id = clean(deviceId);
    if (!this.devices.has(id)) {
      this.devices.set(id, {
        cursor: 0,
        commands: [],
        waiters: new Set(),
        acknowledgementWaiters: new Map(),
        acknowledgements: new Map(),
      });
    }
    return this.devices.get(id);
  }

  enqueue(deviceId, command) {
    const id = clean(deviceId);
    if (!id) throw new Error("device_id is required");
    const state = this.stateFor(id);
    const entry = {
      command_id: clean(command?.command_id) || randomUUID(),
      cursor: ++state.cursor,
      created_at: this.now(),
      ...command,
    };
    state.commands.push(entry);
    if (state.commands.length > MAX_COMMANDS_PER_DEVICE) {
      state.commands.splice(0, state.commands.length - MAX_COMMANDS_PER_DEVICE);
    }
    for (const wake of state.waiters) wake();
    state.waiters.clear();
    return entry;
  }

  commandAfter(deviceId, cursor = 0) {
    const state = this.stateFor(deviceId);
    return state.commands.find((command) =>
      command.cursor > Number(cursor || 0) &&
      !state.acknowledgements.has(command.command_id)
    ) || null;
  }

  async poll(deviceId, cursor = 0, timeoutMs = DEFAULT_POLL_TIMEOUT_MS) {
    const immediate = this.commandAfter(deviceId, cursor);
    if (immediate) return immediate;
    const state = this.stateFor(deviceId);
    const waitMs = Math.max(0, Math.min(Number(timeoutMs || 0), MAX_POLL_TIMEOUT_MS));
    if (!waitMs) return null;

    await new Promise((resolve) => {
      let timer = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        state.waiters.delete(wake);
        resolve();
      };
      state.waiters.add(wake);
      timer = setTimeout(wake, waitMs);
    });
    return this.commandAfter(deviceId, cursor);
  }

  acknowledge(deviceId, payload = {}) {
    const state = this.stateFor(deviceId);
    const commandId = clean(payload.command_id);
    if (!commandId) throw new Error("command_id is required");
    const acknowledgement = {
      command_id: commandId,
      device_id: clean(deviceId),
      status: clean(payload.status) || "acknowledged",
      session_id: clean(payload.session_id),
      error: clean(payload.error),
      acknowledged_at: this.now(),
    };
    state.acknowledgements.set(commandId, acknowledgement);
    const waiters = state.acknowledgementWaiters.get(commandId);
    if (waiters) {
      for (const wake of waiters) wake(acknowledgement);
      state.acknowledgementWaiters.delete(commandId);
    }
    return acknowledgement;
  }

  waitForAcknowledgement(deviceId, commandId, timeoutMs = 30000) {
    const state = this.stateFor(deviceId);
    const id = clean(commandId);
    const existing = state.acknowledgements.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiters = state.acknowledgementWaiters.get(id) || new Set();
      let timer = null;
      const wake = (acknowledgement = null) => {
        if (timer) clearTimeout(timer);
        waiters.delete(wake);
        if (!waiters.size) state.acknowledgementWaiters.delete(id);
        resolve(acknowledgement);
      };
      waiters.add(wake);
      state.acknowledgementWaiters.set(id, waiters);
      timer = setTimeout(wake, Math.max(0, Number(timeoutMs || 0)));
      timer.unref?.();
    });
  }

  latestCursor(deviceId) {
    return this.stateFor(deviceId).cursor;
  }
}

module.exports = M5DeviceCommandBroker;
module.exports.DEFAULT_POLL_TIMEOUT_MS = DEFAULT_POLL_TIMEOUT_MS;
module.exports.MAX_POLL_TIMEOUT_MS = MAX_POLL_TIMEOUT_MS;
