// 生成安装包用的图标：build/icon.ico（16–256 几种尺寸）和 build/icon.png（512）。
// 图标是用代码画的（src/main/iconArt.ts，托盘和窗口用的同一个），不用图片文件。
// 运行：node scripts/make-icon.mjs（npm run dist 会先跑它）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { iconPixels } from '../src/main/iconArt.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA 像素 → PNG 文件 */
function png(size) {
  const px = iconPixels(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // 不用滤波
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 每通道 8 位
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 几张 PNG 打包成 .ico（Windows Vista 起支持 ICO 里放 PNG） */
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 图标
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 每像素位数
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(out, 'icon.png'), png(512));
console.log(`图标已生成：${path.join(out, 'icon.ico')}、icon.png`);
