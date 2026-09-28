const fs = require('fs');

function ffmpegExecutable() {
  const bundled = require('ffmpeg-static').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    return bundled;
  } catch {
    // 开发目录的依赖可能尚未设置执行位；允许使用已经安装的 ffmpeg。
    return 'ffmpeg';
  }
}

module.exports = { ffmpegExecutable };
