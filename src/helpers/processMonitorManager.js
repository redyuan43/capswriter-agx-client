const { spawn } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("crypto").randomUUID ? { v4: () => require("crypto").randomUUID() } : require("uuid");
const EventEmitter = require("events");

class ProcessMonitorManager extends EventEmitter {
  constructor(logger = null) {
    super();
    this.monitors = new Map();
    this.logger = logger;
    this.databaseManager = null;
    this.pythonCmd = null;
  }

  setDatabaseManager(databaseManager) {
    this.databaseManager = databaseManager;
  }

  setPythonCmd(pythonCmd) {
    this.pythonCmd = pythonCmd;
  }

  async getPythonCommand() {
    if (this.pythonCmd) {
      return this.pythonCmd;
    }
    
    const platform = process.platform;
    
    if (platform === "win32") {
      const pythonCommands = ["python", "python3", "py"];
      for (const cmd of pythonCommands) {
        try {
          const { execSync } = require("child_process");
          execSync(`${cmd} --version`, { stdio: "ignore" });
          this.pythonCmd = cmd;
          return cmd;
        } catch {
          continue;
        }
      }
    } else {
      const pythonCommands = ["python3", "python"];
      for (const cmd of pythonCommands) {
        try {
          const { execSync } = require("child_process");
          execSync(`${cmd} --version`, { stdio: "ignore" });
          this.pythonCmd = cmd;
          return cmd;
        } catch {
          continue;
        }
      }
    }
    
    return "python3";
  }

  getMonitorScriptPath() {
    return path.join(
      path.dirname(path.dirname(path.dirname(__dirname))),
      "screen_monitor_ai_running",
      "process_monitor.py"
    );
  }

  async loadConfigs() {
    if (!this.databaseManager) {
      return [];
    }
    
    try {
      const configs = await this.databaseManager.getSetting("process_monitor_configs", []);
      return configs || [];
    } catch (error) {
      this.logger && this.logger.error("加载监控配置失败:", error);
      return [];
    }
  }

  async saveConfigs(configs) {
    if (!this.databaseManager) {
      return false;
    }
    
    try {
      await this.databaseManager.setSetting("process_monitor_configs", configs);
      return true;
    } catch (error) {
      this.logger && this.logger.error("保存监控配置失败:", error);
      return false;
    }
  }

  async addConfig(config) {
    const configs = await this.loadConfigs();
    const newConfig = {
      ...config,
      id: uuidv4 ? uuidv4() : Date.now().toString(),
      enabled: config.enabled !== false,
    };
    configs.push(newConfig);
    await this.saveConfigs(configs);
    return newConfig;
  }

  async updateConfig(id, updates) {
    const configs = await this.loadConfigs();
    const index = configs.findIndex((c) => c.id === id);
    if (index >= 0) {
      configs[index] = { ...configs[index], ...updates };
      await this.saveConfigs(configs);
      return configs[index];
    }
    return null;
  }

  async deleteConfig(id) {
    const configs = await this.loadConfigs();
    const filtered = configs.filter((c) => c.id !== id);
    await this.saveConfigs(filtered);
    
    if (this.monitors.has(id)) {
      this.stopMonitor(id);
    }
    
    return true;
  }

  buildArgs(config) {
    const args = [];
    
    if (config.usePid && config.pid) {
      args.push("--pid", config.pid.toString());
    } else {
      args.push("--name", config.name);
    }
    
    args.push("--cpu-threshold", (config.cpuThreshold || 1.0).toString());
    args.push("--idle-duration", (config.idleDuration || 30).toString());
    args.push("--interval", (config.checkInterval || 2).toString());
    
    return args;
  }

  parseOutput(id, data) {
    const output = data.toString();
    const lines = output.split(/[\r\n]+/);
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const monitor = this.monitors.get(id);
      if (!monitor) continue;

      const statusUpdate = {
        id,
        timestamp: Date.now(),
      };
      
      const runningMatch = trimmed.match(/\[运行中\]\s*CPU:\s*([\d.]+)%/);
      if (runningMatch) {
        statusUpdate.status = "running";
        statusUpdate.cpu = parseFloat(runningMatch[1]);
        monitor.status = statusUpdate;
        this.emit("status-update", statusUpdate);
        continue;
      }
      
      const idleMatch = trimmed.match(/\[空闲\]\s*CPU:\s*([\d.]+)%(?:\s*\|\s*空闲:\s*([\d.]+)s\/([\d.]+)s)?/);
      if (idleMatch) {
        statusUpdate.status = "idle";
        statusUpdate.cpu = parseFloat(idleMatch[1]);
        statusUpdate.idleTime = idleMatch[2] ? parseFloat(idleMatch[2]) : 0;
        statusUpdate.idleDuration = idleMatch[3]
          ? parseFloat(idleMatch[3])
          : (monitor.config?.idleDuration || 30);
        monitor.status = statusUpdate;
        this.emit("status-update", statusUpdate);
        continue;
      }
      
      const alertMatch = trimmed.match(/\[提醒\]/);
      if (alertMatch) {
        statusUpdate.status = "alert";
        statusUpdate.message = trimmed;
        this.emit("alert", statusUpdate);
        continue;
      }
      
      const exitedMatch = trimmed.match(/\[警告\]\s*进程已异常退出/);
      if (exitedMatch) {
        statusUpdate.status = "exited";
        statusUpdate.message = trimmed;
        monitor.status = statusUpdate;
        this.emit("process-exited", statusUpdate);
        this.stopMonitor(id);
        continue;
      }
      
      const errorMatch = trimmed.match(/\[错误\]/);
      if (errorMatch) {
        statusUpdate.status = "error";
        statusUpdate.message = trimmed;
        monitor.status = statusUpdate;
        this.emit("error", statusUpdate);
        continue;
      }
    }
  }

  async startMonitor(id) {
    const configs = await this.loadConfigs();
    const config = configs.find((c) => c.id === id);
    
    if (!config) {
      throw new Error(`监控配置不存在: ${id}`);
    }
    
    if (this.monitors.has(id)) {
      this.logger && this.logger.warn(`监控已在运行: ${id}`);
      return {
        success: false,
        error: "监控已在运行",
        status: this.monitors.get(id).status,
      };
    }
    
    try {
      const pythonCmd = await this.getPythonCommand();
      const scriptPath = this.getMonitorScriptPath();
      const args = this.buildArgs(config);
      
      this.logger && this.logger.info(`启动监控: ${pythonCmd} ${scriptPath} ${args.join(" ")}`);
      
      const proc = spawn(pythonCmd, [scriptPath, ...args], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env },
      });
      
      const monitorInfo = {
        process: proc,
        config,
        status: {
          id,
          status: "starting",
          cpu: 0,
          timestamp: Date.now(),
        },
        startTime: Date.now(),
      };
      
      this.monitors.set(id, monitorInfo);
      this.emit("status-update", monitorInfo.status);
      
      proc.stdout.on("data", (data) => {
        this.parseOutput(id, data);
      });
      
      proc.stderr.on("data", (data) => {
        const errorOutput = data.toString();
        this.logger && this.logger.error(`监控 ${id} 错误输出:`, errorOutput);
        
        if (errorOutput.includes("未找到进程")) {
          this.emit("error", {
            id,
            status: "error",
            message: "未找到指定进程",
            timestamp: Date.now(),
          });
        }
      });
      
      proc.on("close", (code) => {
        this.logger && this.logger.info(`监控 ${id} 进程退出，代码: ${code}`);
        this.monitors.delete(id);
        this.emit("monitor-stopped", { id, code });
      });
      
      proc.on("error", (error) => {
        this.logger && this.logger.error(`监控 ${id} 进程错误:`, error);
        this.monitors.delete(id);
        this.emit("error", {
          id,
          status: "error",
          message: error.message,
          timestamp: Date.now(),
        });
      });
      
      return { success: true };
    } catch (error) {
      this.logger && this.logger.error(`启动监控失败: ${id}`, error);
      return { success: false, error: error.message };
    }
  }

  stopMonitor(id) {
    const monitor = this.monitors.get(id);
    
    if (!monitor) {
      return { success: false, error: "监控未在运行" };
    }
    
    try {
      monitor.process.kill("SIGTERM");
      
      setTimeout(() => {
        if (this.monitors.has(id)) {
          try {
            monitor.process.kill("SIGKILL");
          } catch {
            // 进程可能已退出
          }
        }
      }, 3000);
      
      return { success: true };
    } catch (error) {
      this.logger && this.logger.error(`停止监控失败: ${id}`, error);
      return { success: false, error: error.message };
    }
  }

  stopAllMonitors() {
    const ids = Array.from(this.monitors.keys());
    for (const id of ids) {
      this.stopMonitor(id);
    }
  }

  getMonitorStatus(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) {
      return {
        id,
        status: "stopped",
        timestamp: Date.now(),
      };
    }
    return monitor.status;
  }

  getAllMonitorsStatus() {
    const statuses = [];
    for (const [, monitor] of this.monitors) {
      statuses.push(monitor.status);
    }
    return statuses;
  }

  isRunning(id) {
    return this.monitors.has(id);
  }

  destroy() {
    this.stopAllMonitors();
    this.removeAllListeners();
  }
}

module.exports = ProcessMonitorManager;
