const { BrowserWindow, screen } = require("electron");
const path = require("path");
const { execSync } = require("child_process");

const isHeadless = process.env.SPEECH_TRANSCRIPTION_HEADLESS === '1';
const devServerPort = process.env.VITE_DEV_PORT || '5175';
const devServerUrl = `http://localhost:${devServerPort}`;
const appIconPath = path.join(__dirname, "..", "..", "assets", "icon.png");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.historyWindow = null;
    this.settingsWindow = null;
    this.linkDirectoryWindow = null;
    this.isHeadless = isHeadless;
    this.lastPosition = null;
    this.previousActiveWindow = null; // 记录显示悬浮球前的活动窗口
    this.floatingWindowDefaultSize = { width: 400, height: 72 };
    this.floatingWindowMaxSize = { width: 1100, height: 640 };
  }

  async createMainWindow() {
    if (this.mainWindow) {
      this.mainWindow.focus();
      this.mainWindow.show();
      return this.mainWindow;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    const defaultX = Math.max(0, width - this.floatingWindowDefaultSize.width - 40);
    const defaultY = Math.max(0, height - this.floatingWindowDefaultSize.height - 40);

    this.mainWindow = new BrowserWindow({
      width: this.floatingWindowDefaultSize.width,
      height: this.floatingWindowDefaultSize.height,
      x: this.lastPosition ? this.lastPosition.x : defaultX,
      y: this.lastPosition ? this.lastPosition.y : defaultY,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      movable: true,
      show: false,
      title: '',
      focusable: false,
      hasShadow: false,
      icon: appIconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    this.mainWindow.on('moved', () => {
      if (this.mainWindow) {
        const [x, y] = this.mainWindow.getPosition();
        this.lastPosition = { x, y };
      }
    });

    if (this.isHeadless) {
      this.mainWindow.setAlwaysOnTop(false);
    }

    const isDev = process.env.NODE_ENV === "development";

    try {
      if (isDev) {
        await this.mainWindow.loadURL(devServerUrl);
        console.log(`Main window loaded URL: ${devServerUrl}`);
      } else {
        await this.mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
        console.log('Main window loaded file');
      }
    } catch (loadError) {
      console.error('Failed to load main window:', loadError);
    }

    // 监听页面加载完成事件
    this.mainWindow.webContents.on('did-finish-load', () => {
      console.log('Main window finished loading');
    });

    this.mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('Main window failed to load:', errorCode, errorDescription);
    });

    // 悬浮球默认隐藏，按住录音键时才显示
    // this.mainWindow.show();
    // this.mainWindow.focus();

    // if (isDev) {
    //   this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    //   console.log('DevTools opened');
    // }

    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  showFloatingBall(options = {}) {
    if (this.mainWindow) {
      const rememberActiveWindow = options.rememberActiveWindow !== false;
      // 记录当前活动窗口 (Linux only)
      if (rememberActiveWindow && process.platform === 'linux') {
        try {
          this.previousActiveWindow = execSync('xdotool getactivewindow 2>/dev/null', { encoding: 'utf-8' }).trim();
          console.log('Previous active window:', this.previousActiveWindow);
        } catch {
          this.previousActiveWindow = null;
        }
      }
      
      this.resizeFloatingBall(
        this.floatingWindowDefaultSize.width,
        this.floatingWindowDefaultSize.height
      );
      this.ensureFloatingBallVisible({ preferCursorDisplay: true });
      if (!this.isHeadless) {
        this.mainWindow.setAlwaysOnTop(true, "screen-saver");
        this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      this.mainWindow.showInactive();
      try {
        this.mainWindow.moveTop();
      } catch (_) {
        // Some Linux window managers ignore this for non-focusable utility windows.
      }
      console.log('Floating ball shown', {
        bounds: this.mainWindow.getBounds()
      });
    }
  }

  setFloatingBallInputCaptureEnabled(enabled) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }

    const shouldCapture = !!enabled;
    this.mainWindow.setFocusable(shouldCapture);
    if (shouldCapture) {
      this.mainWindow.show();
      this.mainWindow.focus();
    } else if (process.platform === 'linux') {
      this.mainWindow.blur();
    }
    return true;
  }

  hideFloatingBall() {
    if (this.mainWindow) {
      this.setFloatingBallInputCaptureEnabled(false);
      this.resizeFloatingBall(
        this.floatingWindowDefaultSize.width,
        this.floatingWindowDefaultSize.height
      );
      const [x, y] = this.mainWindow.getPosition();
      this.lastPosition = { x, y };
      this.mainWindow.hide();
      console.log('Floating ball hidden, position saved:', this.lastPosition);
    }
  }

  resizeFloatingBall(width, height) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

    const targetWidth = Math.max(
      this.floatingWindowDefaultSize.width,
      Math.min(this.floatingWindowMaxSize.width, Number(width) || this.floatingWindowDefaultSize.width)
    );
    const targetHeight = Math.max(
      this.floatingWindowDefaultSize.height,
      Math.min(this.floatingWindowMaxSize.height, Number(height) || this.floatingWindowDefaultSize.height)
    );

    const [currentWidth, currentHeight] = this.mainWindow.getSize();
    if (currentWidth === targetWidth && currentHeight === targetHeight) {
      return true;
    }

    this.mainWindow.setSize(targetWidth, targetHeight, true);
    this.ensureFloatingBallVisible();
    return true;
  }

  ensureFloatingBallVisible(options = {}) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;

    const preferCursorDisplay = !!options.preferCursorDisplay;
    const bounds = this.mainWindow.getBounds();
    const display = preferCursorDisplay
      ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      : screen.getDisplayMatching(bounds);
    const area = display?.workArea || screen.getPrimaryDisplay().workArea;
    const margin = 16;
    const maxX = area.x + Math.max(margin, area.width - bounds.width - margin);
    const maxY = area.y + Math.max(margin, area.height - bounds.height - margin);
    const minX = area.x + margin;
    const minY = area.y + margin;
    const clampedX = Math.min(Math.max(bounds.x, minX), maxX);
    const clampedY = Math.min(Math.max(bounds.y, minY), maxY);

    if (clampedX === bounds.x && clampedY === bounds.y) {
      return true;
    }

    this.mainWindow.setPosition(clampedX, clampedY, false);
    this.lastPosition = { x: clampedX, y: clampedY };
    console.log('Floating ball position clamped', {
      from: { x: bounds.x, y: bounds.y },
      to: this.lastPosition,
      workArea: area
    });
    return true;
  }

  async createControlPanelWindow() {
    if (this.isHeadless) {
      return null;
    }

    if (this.controlPanelWindow) {
      this.controlPanelWindow.focus();
      return this.controlPanelWindow;
    }

    this.controlPanelWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      icon: appIconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.controlPanelWindow.loadURL(`${devServerUrl}?panel=control`);
    } else {
      await this.controlPanelWindow.loadFile(
        path.join(__dirname, "..", "dist", "index.html"),
        { query: { panel: "control" } }
      );
    }

    this.controlPanelWindow.on("closed", () => {
      this.controlPanelWindow = null;
    });

    return this.controlPanelWindow;
  }

  async createHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.focus();
      return this.historyWindow;
    }

    this.historyWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      title: "转录历史 - 语音转写",
      alwaysOnTop: true,
      icon: appIconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.historyWindow.loadURL(`${devServerUrl}/history.html`);
    } else {
      await this.historyWindow.loadFile(
        path.join(__dirname, "..", "dist", "history.html")
      );
    }

    this.historyWindow.on("closed", () => {
      this.historyWindow = null;
    });

    return this.historyWindow;
  }

  async createSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      width: 700,
      height: 600,
      show: false,
      title: "设置 - 语音转写",
      alwaysOnTop: true,
      icon: appIconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.settingsWindow.loadURL(`${devServerUrl}?page=settings`);
    } else {
      await this.settingsWindow.loadFile(
        path.join(__dirname, "..", "dist", "settings.html")
      );
    }

    this.settingsWindow.on("closed", () => {
      this.settingsWindow = null;
    });

    return this.settingsWindow;
  }

  async createLinkDirectoryWindow() {
    if (this.isHeadless) {
      return null;
    }

    if (this.linkDirectoryWindow) {
      this.linkDirectoryWindow.focus();
      return this.linkDirectoryWindow;
    }

    this.linkDirectoryWindow = new BrowserWindow({
      width: 980,
      height: 680,
      show: false,
      title: "语音链接表 - 语音转写",
      alwaysOnTop: false,
      icon: appIconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.linkDirectoryWindow.loadURL(`${devServerUrl}?page=links`);
    } else {
      await this.linkDirectoryWindow.loadFile(
        path.join(__dirname, "..", "dist", "index.html"),
        { query: { page: "links" } }
      );
    }

    this.linkDirectoryWindow.on("closed", () => {
      this.linkDirectoryWindow = null;
    });

    return this.linkDirectoryWindow;
  }

  showControlPanel() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
    } else {
      this.createControlPanelWindow().then(() => {
        this.controlPanelWindow.show();
      });
    }
  }

  hideControlPanel() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.hide();
    }
  }

  showHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.show();
      this.historyWindow.focus();
      this.historyWindow.setAlwaysOnTop(true);
    } else {
      this.createHistoryWindow().then(() => {
        this.historyWindow.show();
        this.historyWindow.focus();
        this.historyWindow.setAlwaysOnTop(true);
      });
    }
  }

  hideHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.hide();
    }
  }

  closeHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.close();
    }
  }

  showSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.show();
      this.settingsWindow.focus();
      this.settingsWindow.setAlwaysOnTop(true);
    } else {
      this.createSettingsWindow().then(() => {
        this.settingsWindow.show();
        this.settingsWindow.focus();
        this.settingsWindow.setAlwaysOnTop(true);
      });
    }
  }

  hideSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.hide();
    }
  }

  closeSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.close();
    }
    if (this.linkDirectoryWindow) {
      this.linkDirectoryWindow.close();
    }
  }

  closeAllWindows() {
    if (this.mainWindow) {
      this.mainWindow.close();
    }
    if (this.controlPanelWindow) {
      this.controlPanelWindow.close();
    }
    if (this.historyWindow) {
      this.historyWindow.close();
    }
    if (this.settingsWindow) {
      this.settingsWindow.close();
    }
  }

  showLinkDirectoryWindow() {
    if (this.linkDirectoryWindow) {
      this.linkDirectoryWindow.show();
      this.linkDirectoryWindow.focus();
    } else {
      this.createLinkDirectoryWindow().then(() => {
        if (this.linkDirectoryWindow) {
          this.linkDirectoryWindow.show();
        }
      });
    }
  }
}

module.exports = WindowManager;
