const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EV_KEY = 0x01;
const KEY_CAPSLOCK = 58;
const KEY_RIGHTSHIFT = 54;
const KEY_ESC = 1;
const KEY_ENTER = 28;
const BTN_MIDDLE = 274;
const INPUT_EVENT_SIZE = process.arch === 'x64' || process.arch === 'arm64' ? 24 : 16;
const CAPS_RESTORE_EVENT_IGNORE_MS = 250;
const CAPS_RESTORE_VERIFY_DELAY_MS = 120;
const CAPS_DOUBLE_PRESS_CANCEL_MS = 350;
const LINUX_INPUT_REFRESH_INTERVAL_MS = 2000;
const MINIJOY_INPUT_POLL_INTERVAL_MS = 10;
const DEFAULT_DICTATION_HOLD_KEY = 'right shift';
const DEFAULT_CODEX_HOLD_KEY = 'caps lock';
const EXTRA_KEYBOARD_DEVICE_NAMES = [
  'Knob Mapper Virtual Keyboard',
  'VibeStick MiniJoy Keyboard',
  'VibeStick MiniJoy Mouse'
];
const MINIJOY_MIDDLE_BUTTON_CONFIG = {
  normalizedName: 'minijoy middle button',
  displayName: 'MiniJoy Middle Button',
  uiohookName: '',
  evdevCode: BTN_MIDDLE,
  restoresCapsLock: false
};

function normalizeBluetoothAddress(value) {
  const hex = String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex : '';
}

function miniJoyTriggerId(value) {
  const address = normalizeBluetoothAddress(value);
  return address ? `minijoy_bt:${address}` : 'minijoy_bt';
}

function isMiniJoyTriggerId(value) {
  return value === 'minijoy_bt' || String(value || '').startsWith('minijoy_bt:');
}

function normalizeDictationKeyName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function createHoldKeyConfig(value, fallbackValue = DEFAULT_DICTATION_HOLD_KEY) {
  const normalized = normalizeDictationKeyName(value || fallbackValue);

  if (['caps as right shift', 'caps to right shift', 'caps right shift'].includes(normalized)) {
    return {
      normalizedName: 'caps as right shift',
      displayName: 'Caps as Right Shift',
      uiohookName: 'CapsLock',
      evdevCode: KEY_CAPSLOCK,
      restoresCapsLock: false
    };
  }

  if (['caps', 'capslock', 'caps lock'].includes(normalized)) {
    return {
      normalizedName: 'caps lock',
      displayName: 'Caps Lock',
      uiohookName: 'CapsLock',
      evdevCode: KEY_CAPSLOCK,
      restoresCapsLock: true
    };
  }

  if (['right shift', 'rightshift', 'shift right', 'shiftright', 'rshift'].includes(normalized)) {
    return {
      normalizedName: 'right shift',
      displayName: 'Right Shift',
      uiohookName: 'ShiftRight',
      evdevCode: KEY_RIGHTSHIFT,
      restoresCapsLock: false
    };
  }

  return null;
}

function describeLinuxInputDevice(text, devicePath) {
  const eventName = path.basename(devicePath);
  for (const block of String(text || '').split(/\n\n+/)) {
    const handlersMatch = block.match(/^H:\s+Handlers=(.+)$/m);
    if (!handlersMatch || !handlersMatch[1].trim().split(/\s+/).includes(eventName)) {
      continue;
    }
    const name = block.match(/^N:\s+Name="([^"]+)"$/m)?.[1] || '';
    const deviceUniq = block.match(/^U:\s+Uniq=(.+)$/m)?.[1]?.trim() || '';
    return {
      trigger_id: /VibeStick MiniJoy/i.test(name) ? miniJoyTriggerId(deviceUniq) : 'keyboard',
      device_path: devicePath,
      device_name: name,
      device_phys: block.match(/^P:\s+Phys=(.+)$/m)?.[1]?.trim() || '',
      device_uniq: deviceUniq,
      bluetooth_address: normalizeBluetoothAddress(deviceUniq),
      backend: 'evdev'
    };
  }
  return { trigger_id: 'keyboard', device_path: devicePath, device_name: '', backend: 'evdev' };
}

function discoverNamedLinuxInputDevicePaths(text, names) {
  const wantedNames = new Set((names || []).map((name) => String(name).toLowerCase()));
  if (!wantedNames.size) {
    return [];
  }

  const devicePaths = [];
  for (const block of String(text || '').split(/\n\n+/)) {
    const nameMatch = block.match(/^N:\s+Name="([^"]+)"$/m);
    if (!nameMatch || !wantedNames.has(nameMatch[1].toLowerCase())) {
      continue;
    }
    const handlersMatch = block.match(/^H:\s+Handlers=(.+)$/m);
    if (!handlersMatch) {
      continue;
    }
    for (const handler of handlersMatch[1].trim().split(/\s+/)) {
      if (handler.startsWith('event')) {
        devicePaths.push(path.join('/dev/input', handler));
      }
    }
  }
  return devicePaths;
}

class CapsLockListener {
  constructor(logger = null) {
    this.logger = logger;
    this.dictationKeyConfig =
      createHoldKeyConfig(process.env.CAPS_DICTATION_HOLD_KEY || process.env.DICTATION_HOLD_KEY, DEFAULT_DICTATION_HOLD_KEY) ||
      createHoldKeyConfig(DEFAULT_DICTATION_HOLD_KEY, DEFAULT_DICTATION_HOLD_KEY);
    this.codexKeyConfig =
      createHoldKeyConfig(process.env.CAPS_CODEX_HOLD_KEY || process.env.CODEX_HOLD_KEY, DEFAULT_CODEX_HOLD_KEY) ||
      createHoldKeyConfig(DEFAULT_CODEX_HOLD_KEY, DEFAULT_CODEX_HOLD_KEY);
    this.isCapsLockPressed = false;
    this.onCapsLockDown = null;
    this.onCapsLockUp = null;
    this.onCodexHoldDown = null;
    this.onCodexHoldUp = null;
    this.onDictationCancel = null;
    this.onDictationConfirm = null;
    this.dictationKeyCaptureEnabled = false;
    this.isListening = false;
    this.minHoldMs = 150; // 短按阈值；过滤 Caps 键切换，长按才触发录音
    this._holdTimer = null;
    this._recordingTriggered = false; // 是否已触发录音
    this._backend = null;
    this._uiohook = null;
    this._uiohookKey = null;
    this._inputStreams = [];
    this._inputRefreshTimer = null;
    this._inputPollTimer = null;
    this._inputBuffers = new Map();
    this._inputDeviceInfo = new Map();
    this._inputDeviceHandles = new Map();
    this._evdevHolds = new Map();
    this._ignoreCapsEventsUntil = 0;
    this._capsLockRestoreTargetState = null;
    this._capsLockRestoreVerifyTimer = null;
    this._activeHoldRole = null;
    this._activeHoldKeyConfig = null;
    this._activeHoldSource = null;
    this._lastCapsShortPressAt = 0;
  }

  start() {
    if (this.isListening) {
      this._logInfo(`${this.getListeningKeyDisplayName()} 监听器已经在运行`);
      return true;
    }

    const platform = process.platform;
    const sessionType = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
    const requestedBackend = String(process.env.CAPS_LISTENER_BACKEND || 'auto').toLowerCase();

    try {
      if (platform === 'linux') {
        const shouldUseEvdev =
          requestedBackend === 'wayland-input' ||
          requestedBackend === 'evdev' ||
          (requestedBackend === 'auto' && sessionType === 'wayland');

        if (shouldUseEvdev) {
          const started = this._startLinuxEvdevBackend();
          if (started) {
            this._backend = 'wayland-input';
            this.isListening = true;
            this._logInfo(
              `${this.getListeningKeyDisplayName()} 监听器已启动 (backend=${this._backend}, session=${sessionType || 'unknown'})`
            );
            return true;
          }

          if (requestedBackend === 'wayland-input' || requestedBackend === 'evdev') {
            this._logError(`${this.getListeningKeyDisplayName()} 监听器启动失败: 指定 backend=wayland-input 但初始化失败`);
            return false;
          }

          this._logWarn('Wayland input listener 初始化失败，回退到 uiohook（可能不稳定）');
        }
      }

      this._startUiohookBackend();
      this._backend = 'uiohook';
      this.isListening = true;
      this._logInfo(
        `${this.getListeningKeyDisplayName()} 监听器已启动 (backend=${this._backend}, session=${sessionType || 'unknown'})`
      );
      return true;
    } catch (error) {
      this._logError(`${this.getListeningKeyDisplayName()} 监听器启动失败:`, error);
      return false;
    }
  }

  stop() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._capsLockRestoreVerifyTimer) {
      clearTimeout(this._capsLockRestoreVerifyTimer);
      this._capsLockRestoreVerifyTimer = null;
    }
    if (this._inputRefreshTimer) {
      clearInterval(this._inputRefreshTimer);
      this._inputRefreshTimer = null;
    }
    if (this._inputPollTimer) {
      clearInterval(this._inputPollTimer);
      this._inputPollTimer = null;
    }
    this._recordingTriggered = false;
    this.isCapsLockPressed = false;
    this._activeHoldRole = null;
    this._activeHoldKeyConfig = null;
    this._ignoreCapsEventsUntil = 0;
    this._capsLockRestoreTargetState = null;
    this._lastCapsShortPressAt = 0;

    if (!this.isListening) {
      return;
    }

    try {
      if (this._backend === 'uiohook' && this._uiohook) {
        this._uiohook.stop();
      } else if (this._backend === 'wayland-input') {
        for (const handle of [...this._inputDeviceHandles.values()]) {
          this._closeLinuxInputDevice(handle.devicePath, handle, 'listener_stopped');
        }
        for (const stream of this._inputStreams) {
          try {
            stream.destroy();
          } catch (_) {
            // ignore
          }
        }
        this._inputStreams = [];
        this._inputBuffers.clear();
        this._inputDeviceInfo.clear();
        this._inputDeviceHandles.clear();
        this._clearEvdevHolds('listener_stopped');
      }

      this.isListening = false;
      this._backend = null;
      this._logInfo(`${this.getListeningKeyDisplayName()} 监听器已停止`);
    } catch (error) {
      this._logError(`${this.getListeningKeyDisplayName()} 监听器停止失败:`, error);
    }
  }

  getIsCapsLockPressed() {
    return this.isCapsLockPressed;
  }

  getDictationKeyDisplayName() {
    return this.dictationKeyConfig.displayName;
  }

  getCodexKeyDisplayName() {
    return this.codexKeyConfig.displayName;
  }

  getListeningKeyDisplayName() {
    return `${this.getDictationKeyDisplayName()} + ${this.getCodexKeyDisplayName()}`;
  }

  isCapsLockDictationKey() {
    return this.dictationKeyConfig.restoresCapsLock;
  }

  isCapsLockCodexKey() {
    return this.codexKeyConfig.restoresCapsLock;
  }

  restoreCapsLockState(targetState = null) {
    if (this._backend !== 'uiohook' || !this._uiohook || !this._uiohookKey) {
      return false;
    }

    if (process.platform === 'linux' && typeof targetState === 'boolean') {
      this._ignoreCapsEventsUntil = Date.now() + CAPS_RESTORE_EVENT_IGNORE_MS;
      if (this._capsLockRestoreVerifyTimer) {
        clearTimeout(this._capsLockRestoreVerifyTimer);
      }
      this._capsLockRestoreVerifyTimer = setTimeout(() => {
        this._capsLockRestoreVerifyTimer = null;
        this._ensureLinuxCapsLockState(targetState);
      }, CAPS_RESTORE_VERIFY_DELAY_MS);
      return true;
    }

    this._ignoreCapsEventsUntil = Date.now() + CAPS_RESTORE_EVENT_IGNORE_MS;
    this._uiohook.keyTap(this._uiohookKey.CapsLock);
    return true;
  }

  setOnCapsLockDown(callback) {
    this.onCapsLockDown = callback;
  }

  setOnCapsLockUp(callback) {
    this.onCapsLockUp = callback;
  }

  setOnCodexHoldDown(callback) {
    this.onCodexHoldDown = callback;
  }

  setOnCodexHoldUp(callback) {
    this.onCodexHoldUp = callback;
  }

  setOnDictationCancel(callback) {
    this.onDictationCancel = callback;
  }

  setOnDictationConfirm(callback) {
    this.onDictationConfirm = callback;
  }

  setDictationKeyCaptureEnabled(enabled) {
    this.dictationKeyCaptureEnabled = !!enabled;
    if (!this.dictationKeyCaptureEnabled) {
      this._lastCapsShortPressAt = 0;
    }
  }

  _startUiohookBackend() {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    this._uiohook = uIOhook;
    this._uiohookKey = UiohookKey;
    const holdKeyByCode = this._resolveUiohookHoldKeyMap(UiohookKey);
    const escapeKey = UiohookKey.Escape ?? UiohookKey.Esc;
    const enterKey = UiohookKey.Enter ?? UiohookKey.Return;

    uIOhook.on('keydown', (e) => {
      const holdKey = holdKeyByCode.get(e.keycode);
      if (holdKey) {
        this._handleHoldKeyDown(holdKey.role, holdKey.config, e.keycode, {
          trigger_id: 'keyboard',
          backend: 'uiohook'
        });
        return;
      }

      if (e.keycode === escapeKey) {
        this._handleDictationCancel(e.keycode);
        return;
      }

      if (this.dictationKeyCaptureEnabled && e.keycode === enterKey) {
        this._handleDictationConfirm(e.keycode);
      }
    });

    uIOhook.on('keyup', (e) => {
      const holdKey = holdKeyByCode.get(e.keycode);
      if (holdKey) {
        this._handleHoldKeyUp(holdKey.role, holdKey.config, e.keycode, {
          trigger_id: 'keyboard',
          backend: 'uiohook'
        });
      }
    });

    uIOhook.start();
  }

  _startLinuxEvdevBackend() {
    const devicePaths = this._discoverLinuxKeyboardDevicePaths();
    if (!devicePaths.length) {
      this._logWarn('Wayland input listener 未找到可用输入设备');
      return false;
    }

    let openedCount = 0;
    for (const devicePath of devicePaths) {
      openedCount += this._openLinuxInputDevice(devicePath) ? 1 : 0;
    }

    if (!openedCount) {
      return false;
    }

    this._inputRefreshTimer = setInterval(() => {
      this._refreshLinuxInputDevices();
    }, LINUX_INPUT_REFRESH_INTERVAL_MS);
    this._inputRefreshTimer.unref?.();
    this._inputPollTimer = setInterval(() => {
      this._pollMiniJoyInputDevices();
    }, MINIJOY_INPUT_POLL_INTERVAL_MS);
    this._inputPollTimer.unref?.();

    this._logInfo(`Wayland input listener 已连接 ${openedCount} 个输入设备`, devicePaths);
    return true;
  }

  _openLinuxInputDevice(devicePath) {
    if (this._inputDeviceHandles.has(devicePath)) {
      return false;
    }

    try {
      const deviceInfo = this._describeLinuxInputDevice(devicePath);
      const pollMiniJoy = isMiniJoyTriggerId(deviceInfo.trigger_id);
      const fd = fs.openSync(
        devicePath,
        pollMiniJoy ? fs.constants.O_RDONLY | fs.constants.O_NONBLOCK : 'r'
      );
      const stream = pollMiniJoy ? null : fs.createReadStream(devicePath, {
        fd,
        autoClose: true,
        flags: 'r',
        highWaterMark: INPUT_EVENT_SIZE * 32
      });
      const handle = {
        devicePath,
        stream,
        fd,
        deviceInfo,
        pollMiniJoy,
        readBuffer: pollMiniJoy ? Buffer.alloc(INPUT_EVENT_SIZE * 32) : null,
      };

      this._inputBuffers.set(devicePath, Buffer.alloc(0));
      this._inputDeviceInfo.set(devicePath, deviceInfo);
      this._inputDeviceHandles.set(devicePath, handle);

      if (stream) stream.on('data', (chunk) => {
          this._onInputEventData(devicePath, chunk);
        });
      if (stream) stream.on('error', (error) => {
        if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
          this._logWarn(
            `Wayland input listener 无法读取 ${devicePath} (${error.code})，请将用户加入 input 组或配置 udev 规则`
          );
        } else {
          this._logWarn(`Wayland input listener 设备读取失败 ${devicePath}:`, error?.message || error);
        }
        this._closeLinuxInputDevice(devicePath, handle, 'input_device_error');
      });
      if (stream) stream.on('end', () => {
        this._closeLinuxInputDevice(devicePath, handle, 'input_device_end');
      });
      if (stream) stream.on('close', () => {
        this._closeLinuxInputDevice(devicePath, handle, 'input_device_closed');
      });

      if (stream) this._inputStreams.push(stream);
      return true;
    } catch (error) {
      if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
        this._logWarn(
          `Wayland input listener 无法打开 ${devicePath} (${error.code})，请将用户加入 input 组或配置 udev 规则`
        );
      } else {
        this._logWarn(`Wayland input listener 无法打开 ${devicePath}:`, error?.message || error);
      }
      return false;
    }
  }

  _refreshLinuxInputDevices() {
    const added = [];
    const discovered = new Set(this._discoverLinuxKeyboardDevicePaths());
    for (const [devicePath, handle] of this._inputDeviceHandles) {
      if (!discovered.has(devicePath)) {
        this._closeLinuxInputDevice(devicePath, handle.stream, 'input_device_removed');
        continue;
      }
      const currentInfo = this._describeLinuxInputDevice(devicePath);
      const identityChanged = currentInfo.trigger_id !== handle.deviceInfo.trigger_id ||
        currentInfo.device_name !== handle.deviceInfo.device_name ||
        currentInfo.device_uniq !== handle.deviceInfo.device_uniq;
      if (identityChanged) {
        this._reopenLinuxInputDevice(devicePath, handle);
      }
    }
    for (const devicePath of discovered) {
      if (this._openLinuxInputDevice(devicePath)) {
        added.push(devicePath);
      }
    }
    if (added.length) {
      this._logInfo('Wayland input listener 已连接新输入设备', added);
    }
  }

  _pollMiniJoyInputDevices() {
    for (const handle of [...this._inputDeviceHandles.values()]) {
      if (!handle.pollMiniJoy || typeof handle.fd !== 'number') continue;
      try {
        for (;;) {
          const bytesRead = fs.readSync(handle.fd, handle.readBuffer, 0,
            handle.readBuffer.length, null);
          if (bytesRead <= 0) break;
          this._onInputEventData(handle.devicePath,
            Buffer.from(handle.readBuffer.subarray(0, bytesRead)));
          if (bytesRead < handle.readBuffer.length) break;
        }
      } catch (error) {
        if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') continue;
        this._logWarn(`Wayland input listener MiniJoy 轮询失败 ${handle.devicePath}:`,
          error?.message || error);
        this._closeLinuxInputDevice(handle.devicePath, handle, 'minijoy_poll_error');
      }
    }
  }

  _closeLinuxInputDevice(devicePath, expected, reason) {
    const current = this._inputDeviceHandles.get(devicePath);
    if (!current || (expected !== current && expected !== current.stream)) return;
    this._inputDeviceHandles.delete(devicePath);
    this._inputBuffers.delete(devicePath);
    this._inputDeviceInfo.delete(devicePath);
    this._inputStreams = this._inputStreams.filter((item) => item !== current.stream);
    this._releaseEvdevHoldsForDevice(devicePath, reason);
    if (current.stream && !current.stream.destroyed) current.stream.destroy();
    if (!current.stream && typeof current.fd === 'number') {
      try {
        fs.closeSync(current.fd);
      } catch (_) {
        // Already closed by the kernel/device removal path.
      }
    }
  }

  _reopenLinuxInputDevice(devicePath, handle) {
    this._closeLinuxInputDevice(devicePath, handle, 'input_device_identity_changed');
    if (this._openLinuxInputDevice(devicePath)) {
      this._logInfo('Wayland input listener 已重建输入设备', {
        devicePath,
        trigger_id: this._inputDeviceInfo.get(devicePath)?.trigger_id,
        reason: 'identity_changed',
      });
    }
  }

  _discoverLinuxKeyboardDevicePaths() {
    const explicitDevices = this._parseExplicitLinuxInputDevices(process.env.CAPS_INPUT_DEVICE);
    if (explicitDevices.length) {
      return explicitDevices;
    }

    const candidates = new Set();

    for (const dir of ['/dev/input/by-path', '/dev/input/by-id']) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('-event-kbd')) continue;
          const fullPath = path.join(dir, name);
          try {
            const resolved = fs.realpathSync(fullPath);
            if (resolved.startsWith('/dev/input/event')) {
              candidates.add(resolved);
            }
          } catch (_) {
            // Ignore broken symlink / permission issue here; open() path later will report.
          }
        }
      } catch (_) {
        // Ignore and try next strategy.
      }
    }

    for (const devicePath of this._discoverLinuxKeyboardDevicePathsByName(EXTRA_KEYBOARD_DEVICE_NAMES)) {
      candidates.add(devicePath);
    }

    // Fallback: if by-path/by-id are unavailable, allow manual wildcard-like scan.
    if (!candidates.size) {
      try {
        for (const name of fs.readdirSync('/dev/input')) {
          if (name.startsWith('event')) {
            candidates.add(path.join('/dev/input', name));
          }
        }
      } catch (_) {
        // ignore
      }
    }

    return Array.from(candidates).sort();
  }

  _parseExplicitLinuxInputDevices(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item));
  }

  _discoverLinuxKeyboardDevicePathsByName(names) {
    let text = '';
    try {
      text = fs.readFileSync('/proc/bus/input/devices', 'utf8');
    } catch (_) {
      return [];
    }

    return discoverNamedLinuxInputDevicePaths(text, names);
  }

  _describeLinuxInputDevice(devicePath) {
    let text = '';
    try {
      text = fs.readFileSync('/proc/bus/input/devices', 'utf8');
    } catch (_) {
      return { trigger_id: 'keyboard', device_path: devicePath, device_name: '', backend: 'evdev' };
    }
    return describeLinuxInputDevice(text, devicePath);
  }

  _onInputEventData(devicePath, chunk) {
    const prev = this._inputBuffers.get(devicePath) || Buffer.alloc(0);
    let data = prev.length ? Buffer.concat([prev, chunk]) : chunk;
    const eventSize = INPUT_EVENT_SIZE;

    while (data.length >= eventSize) {
      const evt = data.subarray(0, eventSize);
      data = data.subarray(eventSize);

      const typeOffset = eventSize - 8;
      const codeOffset = eventSize - 6;
      const valueOffset = eventSize - 4;

      const type = evt.readUInt16LE(typeOffset);
      const code = evt.readUInt16LE(codeOffset);
      const value = evt.readInt32LE(valueOffset);

      if (type !== EV_KEY) {
        continue;
      }

      const source = this._inputDeviceInfo.get(devicePath) || {
        trigger_id: 'keyboard',
        device_path: devicePath,
        backend: 'evdev'
      };
      const holdKey = this._findHoldKeyByEvdevCode(code, source);
      if (holdKey && value === 1) {
        this._handleHoldKeyDown(holdKey.role, holdKey.config, code, source);
      } else if (holdKey && value === 0) {
        this._handleHoldKeyUp(holdKey.role, holdKey.config, code, source);
      } else if (code === KEY_ESC && value === 1) {
        this._handleDictationCancel(KEY_ESC);
      } else if (this.dictationKeyCaptureEnabled && code === KEY_ENTER && value === 1) {
        this._handleDictationConfirm(KEY_ENTER);
      }
      // value === 2 is auto-repeat, ignore
    }

    this._inputBuffers.set(devicePath, data);
  }

  _handleHoldKeyDown(role, keyConfig, keycode, source = {}) {
    if (source.backend === 'evdev' && source.device_path) {
      this._handleEvdevHoldKeyDown(role, keyConfig, keycode, source);
      return;
    }
    if (this._shouldIgnoreCapsEvent()) return;
    if (this.isCapsLockPressed) return;

    this.isCapsLockPressed = true;
    this._activeHoldRole = role;
    this._activeHoldKeyConfig = keyConfig;
    this._activeHoldSource = {
      trigger_id: source.trigger_id || 'keyboard',
      ...source
    };
    this._recordingTriggered = false;
    this._logInfo(`${keyConfig.displayName} 按下, keycode:`, keycode);

    if (this.minHoldMs > 0) {
      // 短按过滤：超过阈值后才触发录音，确保 <= 阈值的轻按不激活。
      this._holdTimer = setTimeout(() => {
        this._holdTimer = null;
        if (this.isCapsLockPressed) {
          this._recordingTriggered = true;
          if (keyConfig.restoresCapsLock) {
            this._lastCapsShortPressAt = 0;
            this._captureLinuxCapsLockRestoreTarget();
          }
          this._emitHoldKeyDown(role, this._activeHoldSource);
        }
      }, this.minHoldMs + 1);
      return;
    }

    this._recordingTriggered = true;
    if (keyConfig.restoresCapsLock) {
      this._lastCapsShortPressAt = 0;
      this._captureLinuxCapsLockRestoreTarget();
    }
    this._emitHoldKeyDown(role, this._activeHoldSource);
  }

  _handleHoldKeyUp(role, keyConfig, keycode, source = {}) {
    if (source.backend === 'evdev' && source.device_path) {
      this._handleEvdevHoldKeyUp(role, keyConfig, keycode, source);
      return;
    }
    if (this._shouldIgnoreCapsEvent()) return;
    if (!this.isCapsLockPressed) return;
    if (this._activeHoldRole !== role || this._activeHoldKeyConfig !== keyConfig) {
      this._logInfo(`${keyConfig.displayName} 松开已忽略，当前激活键是 ${this._activeHoldKeyConfig?.displayName || 'none'}`);
      return;
    }

    this.isCapsLockPressed = false;

    if (this._holdTimer) {
      // 短按：定时器还没触发就松开了，取消，不录音
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
      this._activeHoldRole = null;
      this._activeHoldKeyConfig = null;
      this._activeHoldSource = null;
      this._handleShortHoldKeyPress(role, keyConfig, keycode);
      this._logInfo(keyConfig.displayName + ' 短按忽略 (<= ' + this.minHoldMs + 'ms)');
      return;
    }

    this._logInfo(`${keyConfig.displayName} 松开, keycode:`, keycode);

    if (this._recordingTriggered) {
      this._recordingTriggered = false;
      this._emitHoldKeyUp(role, this._activeHoldSource || source);
      if (keyConfig.restoresCapsLock) {
        this._restoreLinuxCapsLockAfterLongPress();
      }
      this._capsLockRestoreTargetState = null;
    }
    this._activeHoldRole = null;
    this._activeHoldKeyConfig = null;
    this._activeHoldSource = null;
  }

  _evdevHoldId(role, keyConfig, source = {}) {
    return `${source.device_path || 'unknown'}:${role}:${keyConfig.evdevCode}`;
  }

  _handleEvdevHoldKeyDown(role, keyConfig, keycode, source = {}) {
    if (this._shouldIgnoreCapsEvent()) return;
    const holdId = this._evdevHoldId(role, keyConfig, source);
    if (this._evdevHolds.has(holdId)) return;

    const hold = {
      id: holdId,
      role,
      keyConfig,
      keycode,
      source: { trigger_id: source.trigger_id || 'keyboard', ...source },
      timer: null,
      recordingTriggered: false,
    };
    this._evdevHolds.set(holdId, hold);
    this.isCapsLockPressed = true;
    this._logInfo(`${keyConfig.displayName} 按下, keycode:`, keycode);

    const trigger = () => {
      hold.timer = null;
      if (!this._evdevHolds.has(holdId)) return;
      hold.recordingTriggered = true;
      if (keyConfig.restoresCapsLock) {
        this._lastCapsShortPressAt = 0;
        this._captureLinuxCapsLockRestoreTarget();
      }
      this._emitHoldKeyDown(role, hold.source);
    };

    if (this.minHoldMs > 0) {
      hold.timer = setTimeout(trigger, this.minHoldMs + 1);
      hold.timer.unref?.();
    } else {
      trigger();
    }
  }

  _handleEvdevHoldKeyUp(role, keyConfig, keycode, source = {}) {
    const holdId = this._evdevHoldId(role, keyConfig, source);
    const hold = this._evdevHolds.get(holdId);
    if (!hold) return;
    this._finishEvdevHold(hold, keycode, false, 'key_released');
  }

  _finishEvdevHold(hold, keycode, forced, reason) {
    this._evdevHolds.delete(hold.id);
    this.isCapsLockPressed = this._evdevHolds.size > 0;
    if (hold.timer) {
      clearTimeout(hold.timer);
      hold.timer = null;
      if (!forced) {
        this._handleShortHoldKeyPress(hold.role, hold.keyConfig, keycode);
        this._logInfo(hold.keyConfig.displayName + ' 短按忽略 (<= ' + this.minHoldMs + 'ms)');
      }
      return;
    }

    this._logInfo(`${hold.keyConfig.displayName} ${forced ? '强制释放' : '松开'}, keycode:`, keycode, {
      reason,
      trigger_id: hold.source.trigger_id,
      device_path: hold.source.device_path,
    });
    if (hold.recordingTriggered) {
      this._emitHoldKeyUp(hold.role, { ...hold.source, forced, reason });
      if (hold.keyConfig.restoresCapsLock) {
        this._restoreLinuxCapsLockAfterLongPress();
      }
    }
  }

  _releaseEvdevHoldsForDevice(devicePath, reason = 'input_device_closed') {
    for (const hold of [...this._evdevHolds.values()]) {
      if (hold.source.device_path === devicePath) {
        this._finishEvdevHold(hold, hold.keycode, true, reason);
      }
    }
  }

  _clearEvdevHolds(reason = 'listener_stopped') {
    for (const hold of [...this._evdevHolds.values()]) {
      this._finishEvdevHold(hold, hold.keycode, true, reason);
    }
  }

  _emitHoldKeyDown(role, source = {}) {
    if (role === 'codex') {
      if (this.onCodexHoldDown) this.onCodexHoldDown(source);
      return;
    }

    if (this.onCapsLockDown) this.onCapsLockDown(source);
  }

  _emitHoldKeyUp(role, source = {}) {
    if (role === 'codex') {
      if (this.onCodexHoldUp) this.onCodexHoldUp(source);
      return;
    }

    if (this.onCapsLockUp) this.onCapsLockUp(source);
  }

  _handleShortHoldKeyPress(_role, keyConfig, keycode) {
    if (!keyConfig.restoresCapsLock) {
      return;
    }

    if (!this.dictationKeyCaptureEnabled) {
      this._lastCapsShortPressAt = 0;
      return;
    }

    const now = Date.now();
    const elapsed = now - this._lastCapsShortPressAt;
    if (this._lastCapsShortPressAt && elapsed >= 0 && elapsed <= CAPS_DOUBLE_PRESS_CANCEL_MS) {
      this._lastCapsShortPressAt = 0;
      this._handleDictationCancel(keycode, 'caps_double_press');
      return;
    }

    this._lastCapsShortPressAt = now;
  }

  _findHoldKeyByEvdevCode(code, source = {}) {
    if (isMiniJoyTriggerId(source.trigger_id) && code === BTN_MIDDLE) {
      return { role: 'dictation', config: MINIJOY_MIDDLE_BUTTON_CONFIG };
    }
    if (code === this.dictationKeyConfig.evdevCode) {
      return { role: 'dictation', config: this.dictationKeyConfig };
    }
    if (code === this.codexKeyConfig.evdevCode) {
      return { role: 'codex', config: this.codexKeyConfig };
    }
    return null;
  }

  _resolveUiohookHoldKeyMap(UiohookKey) {
    const holdKeyByCode = new Map();
    const dictationCode = this._resolveUiohookKeyCode(UiohookKey, this.dictationKeyConfig, createHoldKeyConfig(DEFAULT_DICTATION_HOLD_KEY));
    const codexCode = this._resolveUiohookKeyCode(UiohookKey, this.codexKeyConfig, createHoldKeyConfig(DEFAULT_CODEX_HOLD_KEY));

    holdKeyByCode.set(dictationCode, { role: 'dictation', config: this.dictationKeyConfig });
    if (!holdKeyByCode.has(codexCode)) {
      holdKeyByCode.set(codexCode, { role: 'codex', config: this.codexKeyConfig });
    } else {
      this._logWarn(`${this.codexKeyConfig.displayName} 已被普通语音键占用，Codex hold 键未启用`);
    }
    return holdKeyByCode;
  }

  _resolveUiohookKeyCode(UiohookKey, keyConfig, fallbackConfig) {
    const keyCode = UiohookKey[keyConfig.uiohookName];
    if (typeof keyCode === 'number') {
      return keyCode;
    }

    this._logWarn(
      `uiohook 不支持 ${keyConfig.displayName}，回退到 ${fallbackConfig.displayName}`
    );
    return UiohookKey[fallbackConfig.uiohookName];
  }

  _captureLinuxCapsLockRestoreTarget() {
    this._capsLockRestoreTargetState = null;

    if (process.platform !== 'linux') {
      return;
    }

    const currentState = this._readLinuxCapsLockState();
    if (currentState === null) {
      this._logWarn('无法读取 Caps Lock 状态，长按结束后将跳过状态恢复');
      return;
    }

    // 长按开始时系统已经完成一次 CapsLock 切换；目标状态是切换前的状态。
    this._capsLockRestoreTargetState = !currentState;
  }

  _restoreLinuxCapsLockAfterLongPress() {
    if (process.platform !== 'linux') {
      return false;
    }

    if (typeof this._capsLockRestoreTargetState !== 'boolean') {
      this._logWarn('缺少 Caps Lock 目标状态，跳过长按后的状态恢复');
      return false;
    }

    const targetState = this._capsLockRestoreTargetState;
    const restored = this.restoreCapsLockState(targetState);
    if (restored) {
      this._logInfo('Caps Lock 长按后状态恢复已调度', { targetState });
    } else {
      this._logWarn('Caps Lock 长按后状态恢复失败', { targetState, backend: this._backend });
    }
    return restored;
  }

  _readLinuxCapsLockState() {
    if (process.platform !== 'linux') {
      return null;
    }

    try {
      const output = execFileSync('xset', ['q'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = output.match(/\bCaps Lock:\s+(on|off)\b/i);
      if (!match) {
        return null;
      }
      return match[1].toLowerCase() === 'on';
    } catch (_error) {
      return null;
    }
  }

  _ensureLinuxCapsLockState(targetState) {
    const currentState = this._readLinuxCapsLockState();
    if (currentState === targetState) {
      this._logInfo('Caps Lock 状态验证通过', { targetState, backend: 'uiohook' });
      return true;
    }

    if (currentState === null) {
      this._logWarn('无法验证 Caps Lock 状态，跳过 xdotool fallback');
      return false;
    }

    try {
      this._ignoreCapsEventsUntil = Date.now() + CAPS_RESTORE_EVENT_IGNORE_MS;
      execFileSync('xdotool', ['key', 'Caps_Lock'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      this._logWarn('xdotool fallback 恢复 Caps Lock 状态失败', {
        targetState,
        currentState,
        error: error?.message || String(error)
      });
      return false;
    }

    const fallbackState = this._readLinuxCapsLockState();
    if (fallbackState === targetState) {
      this._logInfo('Caps Lock 状态已通过 xdotool fallback 恢复', { targetState });
      return true;
    }

    this._logWarn('Caps Lock 状态 fallback 后仍未达到目标', {
      targetState,
      currentState: fallbackState
    });
    return false;
  }

  _shouldIgnoreCapsEvent() {
    return this._ignoreCapsEventsUntil > Date.now();
  }

  _handleDictationCancel(keycode, reason = 'escape') {
    this._logInfo('Dictation cancel key pressed, keycode:', keycode, { reason });
    if (this.onDictationCancel) {
      this.onDictationCancel({ reason, keycode });
    }
  }

  _handleDictationConfirm(keycode) {
    this._logInfo('Dictation confirm key pressed, keycode:', keycode);
    if (this.onDictationConfirm) {
      this.onDictationConfirm();
    }
  }

  _logInfo(...args) {
    if (this.logger && this.logger.info) {
      this.logger.info(...args);
    }
  }

  _logWarn(...args) {
    if (this.logger && this.logger.warn) {
      this.logger.warn(...args);
    } else if (this.logger && this.logger.info) {
      this.logger.info(...args);
    }
  }

  _logError(...args) {
    if (this.logger && this.logger.error) {
      this.logger.error(...args);
    } else if (this.logger && this.logger.warn) {
      this.logger.warn(...args);
    }
  }
}

module.exports = CapsLockListener;
module.exports.describeLinuxInputDevice = describeLinuxInputDevice;
module.exports.discoverNamedLinuxInputDevicePaths = discoverNamedLinuxInputDevicePaths;
module.exports.normalizeBluetoothAddress = normalizeBluetoothAddress;
module.exports.miniJoyTriggerId = miniJoyTriggerId;
module.exports.isMiniJoyTriggerId = isMiniJoyTriggerId;
