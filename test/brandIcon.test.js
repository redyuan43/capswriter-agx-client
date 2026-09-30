const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * 品牌资源没有可用的图像依赖，这里直接解 PNG。
 * 图标由 Pillow 以 8 位 RGBA、非隔行写出，结构固定，因此不需要完整的 PNG 实现。
 */
function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
  if (distances[0] <= distances[1] && distances[0] <= distances[2]) return left;
  return distances[1] <= distances[2] ? up : upLeft;
}

function readPng(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} 不是 PNG`);
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  assert.ok(header, `${file} 缺少 IHDR`);
  assert.equal(header.bitDepth, 8, `${file} 位深不是 8`);
  assert.equal(header.colorType, 6, `${file} 不是 RGBA`);
  assert.equal(header.interlace, 0, `${file} 不是非隔行`);

  const bpp = 4;
  const stride = header.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[(y - 1) * stride + x - bpp] : 0;
      const value = filter === 0 ? line[x]
        : filter === 1 ? line[x] + left
        : filter === 2 ? line[x] + up
        : filter === 3 ? line[x] + Math.floor((left + up) / 2)
        : filter === 4 ? line[x] + paeth(left, up, upLeft)
        : assert.fail(`${file} 使用了不支持的过滤器 ${filter}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { ...header, pixels };
}

// 波尔多配色（SIYUAN 配色第三迭代 · 方向 II）
const BORDEAUX = [105, 30, 46];   // #691E2E
const IVORY = [247, 242, 238];    // #F7F2EE
const LEGACY_GREEN = [22, 163, 74]; // #16A34A

function distanceToBrandRamp(pixel) {
  const vector = IVORY.map((value, index) => value - BORDEAUX[index]);
  const squared = vector.reduce((total, value) => total + value * value, 0);
  const projection = pixel.reduce(
    (total, value, index) => total + (value - BORDEAUX[index]) * vector[index],
    0
  ) / squared;
  const clamped = Math.min(1, Math.max(0, projection));
  const closest = BORDEAUX.map((value, index) => value + clamped * vector[index]);
  return Math.sqrt(pixel.reduce((total, value, index) => total + (value - closest[index]) ** 2, 0));
}

function colorDistance(left, right) {
  return Math.sqrt(left.reduce((total, value, index) => total + (value - right[index]) ** 2, 0));
}

for (const [file, expectedSize] of [['assets/icon.png', 512], ['assets/tray-icon.png', 64]]) {
  test(`品牌图标 ${file} 为波尔多酒红配色且结构未变`, () => {
    const image = readPng(path.join(__dirname, '..', file));
    assert.equal(image.width, expectedSize);
    assert.equal(image.height, expectedSize);

    let transparent = 0;
    let bordeaux = 0;
    let ivory = 0;
    let offRamp = 0;
    let greenest = Infinity;
    for (let index = 0; index < image.pixels.length; index += 4) {
      const pixel = [image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]];
      const alpha = image.pixels[index + 3];
      if (alpha === 0) {
        transparent += 1;
        continue;
      }
      greenest = Math.min(greenest, colorDistance(pixel, LEGACY_GREEN));
      if (distanceToBrandRamp(pixel) > 12) offRamp += 1;
      if (colorDistance(pixel, BORDEAUX) <= 2) bordeaux += 1;
      if (colorDistance(pixel, IVORY) <= 2) ivory += 1;
    }

    assert.ok(transparent > 0, `${file} 丢失透明区域`);
    assert.ok(bordeaux > 0, `${file} 没有圆底主色 #691E2E 像素`);
    assert.ok(ivory > 0, `${file} 没有象牙白 #F7F2EE 的 S 像素`);
    // 抗锯齿像素必须落在两个新基色之间，否则说明换色改变了结构
    assert.equal(offRamp, 0, `${file} 有 ${offRamp} 个像素偏离波尔多-象牙白渐变`);
    assert.ok(greenest > 60, `${file} 仍残留旧绿像素（最近距离 ${greenest.toFixed(1)}）`);
    assert.equal(image.pixels[3], 0, `${file} 左上角应为透明`);
  });
}
