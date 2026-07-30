const { app, dialog, Tray, Menu, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

class TrayManager {
  constructor(logger = null) {
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.createControlPanelCallback = null;
    this.createSettingsWindowCallback = null;
    this.logger = logger;
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setCreateControlPanelCallback(callback) {
    this.createControlPanelCallback = callback;
  }

  setCreateSettingsWindowCallback(callback) {
    this.createSettingsWindowCallback = callback;
  }

  async createTray() {
    try {
      const { iconPath, trayIcon } = this.loadTrayIcon();
      if (!trayIcon) {
        throw new Error("No usable tray icon asset was found");
      }

      this.tray = new Tray(trayIcon);
      this.tray.setImage(trayIcon);
      this.tray.setToolTip("语音转写 - 中文语音转文字");

      // 创建上下文菜单
      this.updateContextMenu();

      // 设置点击事件
      this.tray.on("click", () => {
        if (this.mainWindow) {
          if (this.mainWindow.isVisible()) {
            this.mainWindow.hide();
          } else {
            this.mainWindow.show();
            this.mainWindow.focus();
          }
        }
      });

      this.tray.on("right-click", () => {
        this.tray.popUpContextMenu();
      });

      this.logger?.info?.("System tray icon ready", { iconPath });
      return true;
    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error("创建托盘失败:", error);
      }
      return false;
    }
  }

  loadTrayIcon() {
    for (const iconPath of this.getTrayIconPaths()) {
      if (!fs.existsSync(iconPath)) {
        continue;
      }

      let trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
        this.logger?.warn?.("Tray icon asset could not be decoded", { iconPath });
        continue;
      }

      if (process.platform === "darwin") {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
        trayIcon.setTemplateImage(true);
      }

      return { iconPath, trayIcon };
    }

    return { iconPath: null, trayIcon: null };
  }

  getTrayIconPaths() {
    const assetsDirs = [
      path.join(app.getAppPath(), "assets"),
      path.join(process.resourcesPath, "assets"),
      path.join(__dirname, "..", "..", "assets"),
    ];

    return [...new Set(assetsDirs)].flatMap((assetsDir) => [
      path.join(assetsDir, "tray-icon.png"),
      path.join(assetsDir, "icon.png"),
    ]);
  }

  updateContextMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => {
          if (this.mainWindow) {
            this.mainWindow.show();
            this.mainWindow.focus();
          }
        }
      },
      {
        label: "控制面板",
        click: () => {
          if (this.controlPanelWindow) {
            this.controlPanelWindow.show();
            this.controlPanelWindow.focus();
          } else if (this.createControlPanelCallback) {
            this.createControlPanelCallback().then(() => {
              if (this.controlPanelWindow) {
                this.controlPanelWindow.show();
              }
            });
          }
        }
      },
      {
        label: "进程监控",
        click: () => {
          if (this.createSettingsWindowCallback) {
            this.createSettingsWindowCallback();
          }
        }
      },
      { type: "separator" },
      {
        label: "关于",
        click: () => {
          dialog.showMessageBox({
            type: "info",
            title: "关于 CapsWriter",
            message: `CapsWriter AGX Client\n版本 ${app.getVersion()}`,
            buttons: ["确定"]
          });
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          require("electron").app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  setStatus(status) {
    if (!this.tray) return;

    switch (status) {
      case "recording":
        this.tray.setToolTip("语音转写 - 正在录音...");
        break;
      case "processing":
        this.tray.setToolTip("语音转写 - 正在处理...");
        break;
      case "ready":
      default:
        this.tray.setToolTip("语音转写 - 中文语音转文字");
        break;
    }
  }
}

module.exports = TrayManager;
