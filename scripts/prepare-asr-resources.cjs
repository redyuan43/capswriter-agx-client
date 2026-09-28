const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// 只设置新构建产物中的执行位，源依赖和已安装客户端不受影响。
module.exports = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app/Contents/Resources`)
    : path.join(context.appOutDir, 'resources');
  const name = context.electronPlatformName === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpeg = path.join(resources, 'app.asar.unpacked/node_modules/ffmpeg-static', name);
  if (!fs.existsSync(ffmpeg)) throw new Error('打包产物缺少 ffmpeg，不能交付文件转写');
  // 可提供已验证的同版本二进制修复损坏下载，仅替换这次构建的输出文件。
  if (process.env.CAPS_BUILD_FFMPEG) {
    fs.copyFileSync(process.env.CAPS_BUILD_FFMPEG, ffmpeg);
    for (const suffix of ['.README', '.LICENSE']) {
      const source = `${process.env.CAPS_BUILD_FFMPEG}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${ffmpeg}${suffix}`);
    }
  }
  if (context.electronPlatformName !== 'win32') fs.chmodSync(ffmpeg, 0o755);
  const hostArch = { x64: 1, arm64: 3, ia32: 0, arm: 2 }[process.arch];
  if (context.electronPlatformName === process.platform && context.arch === hostArch) {
    const check = spawnSync(ffmpeg, ['-version'], { timeout: 10000, encoding: 'utf8' });
    if (check.status !== 0 || !check.stdout?.startsWith('ffmpeg version')) {
      throw new Error('打包产物 ffmpeg 无法运行（可能下载损坏），请提供完整的 CAPS_BUILD_FFMPEG 后重试');
    }
  }
};
