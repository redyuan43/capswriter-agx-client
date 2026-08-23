const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

class LogManager {
  constructor({
    fsModule = fs,
    pathModule = path,
    userDataPath = "",
    consoleRef = console,
    consoleEnabled = process.env.CAPSWRITER_CONSOLE_LOGS === "1",
    maxLogBytes = DEFAULT_MAX_LOG_BYTES,
    maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  } = {}) {
    this.fs = fsModule;
    this.path = pathModule;
    this.userDataPath = userDataPath;
    this.console = consoleRef;
    this.consoleEnabled = consoleEnabled;
    this.maxLogBytes = maxLogBytes;
    this.maxPendingBytes = maxPendingBytes;
    this.pendingLines = [];
    this.pendingBytes = 0;
    this.writeInFlight = false;
    this.flushScheduled = false;
    this.droppedEntries = 0;
    this.logDir = this.getLogDirectory();
    this.logFile = this.path.join(this.logDir, 'app.log');
    this.ensureLogDirectory();
    this.rotateOversizedLog();
  }

  getLogDirectory() {
    const userDataPath = this.userDataPath || require('electron').app.getPath('userData');
    return this.path.join(userDataPath, 'logs');
  }

  ensureLogDirectory() {
    try {
      if (!this.fs.existsSync(this.logDir)) {
        this.fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (error) {
      console.error('创建日志目录失败:', error);
    }
  }

  rotateOversizedLog() {
    try {
      if (!this.fs.existsSync(this.logFile) ||
          this.fs.statSync(this.logFile).size < this.maxLogBytes) {
        return;
      }
      const rotated = `${this.logFile}.1`;
      if (this.fs.existsSync(rotated)) {
        this.fs.unlinkSync(rotated);
      }
      this.fs.renameSync(this.logFile, rotated);
    } catch (error) {
      console.error('轮转日志文件失败:', error);
    }
  }

  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      data,
      pid: process.pid
    };

    if (this.consoleEnabled) {
      const output = this.console[level] || this.console.log;
      output.call(this.console, `[${timestamp}] ${message}`, data || '');
    }

    const logLine = JSON.stringify(logEntry) + '\n';
    const bytes = Buffer.byteLength(logLine);
    if (this.pendingBytes + bytes > this.maxPendingBytes &&
        (level === 'info' || level === 'debug')) {
      this.droppedEntries += 1;
      return;
    }
    this.pendingLines.push(logLine);
    this.pendingBytes += bytes;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushScheduled || this.writeInFlight) {
      return;
    }
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  flush() {
    if (this.writeInFlight || this.pendingLines.length === 0) {
      return;
    }
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.pendingBytes = 0;
    if (this.droppedEntries > 0) {
      lines.unshift(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        message: 'Log entries dropped while asynchronous writer was busy',
        data: { count: this.droppedEntries },
        pid: process.pid,
      }) + '\n');
      this.droppedEntries = 0;
    }
    this.writeInFlight = true;
    this.fs.appendFile(this.logFile, lines.join(''), (error) => {
      this.writeInFlight = false;
      if (error) {
        this.console.error('写入日志文件失败:', error);
      }
      this.scheduleFlush();
    });
  }

  info(message, data) {
    this.log('info', message, data);
  }

  error(message, data) {
    this.log('error', message, data);
  }

  warn(message, data) {
    this.log('warn', message, data);
  }

  debug(message, data) {
    this.log('debug', message, data);
  }

  // 获取最近的日志
  getRecentLogs(lines = 100) {
    try {
      if (!this.fs.existsSync(this.logFile)) {
        return [];
      }
      const stats = this.fs.statSync(this.logFile);
      const readBytes = Math.min(stats.size, Math.max(64 * 1024, lines * 4096));
      const fd = this.fs.openSync(this.logFile, 'r');
      const buffer = Buffer.alloc(readBytes);
      this.fs.readSync(fd, buffer, 0, readBytes, stats.size - readBytes);
      this.fs.closeSync(fd);
      const content = buffer.toString('utf8');
      const logLines = content.trim().split('\n').filter(line => line.trim());
      
      return logLines
        .slice(-lines)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return { message: line, timestamp: new Date().toISOString() };
          }
        });
    } catch (error) {
      console.error('读取日志文件失败:', error);
      return [];
    }
  }

  // 清理旧日志
  cleanOldLogs(daysToKeep = 7) {
    try {
      const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

      if (this.fs.existsSync(this.logFile)) {
        const stats = this.fs.statSync(this.logFile);
        if (stats.mtime.getTime() < cutoffTime) {
          this.fs.unlinkSync(this.logFile);
          this.info(`清理旧日志文件: ${this.logFile}`);
        }
      }
    } catch (error) {
      console.error('清理旧日志失败:', error);
    }
  }

  // 获取日志文件路径
  getLogFilePath() {
    return this.logFile;
  }

  // 获取系统信息用于调试
  getSystemInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      appVersion: require('electron').app.getVersion(),
      userDataPath: require('electron').app.getPath('userData'),
      logDir: this.logDir,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        PYTHON_PATH: process.env.PYTHON_PATH
      }
    };
  }
}

module.exports = LogManager;
