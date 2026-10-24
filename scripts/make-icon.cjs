'use strict';
/* 生成托盘图标 build/tray.png —— 纯 Node，无依赖。
   图案：青绿圆角方块 + 白色五瓣花。 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 32;

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function roundedRectAlpha(x, y, r) {
  // 方块范围 1..31，圆角 r
  const x0 = 1, y0 = 1, x1 = S - 1, y1 = S - 1;
  const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  if (d <= r) return 1;
  return 0;
}

function circleAlpha(x, y, cx, cy, r) {
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  if (d <= r - 1) return 1;
  if (d >= r) return 0;
  return r - d;
}

const BG = hex('#0f766e');
const FG = [255, 255, 255];

const petals = [];
for (let k = 0; k < 5; k++) {
  const a = (-90 + k * 72) * (Math.PI / 180);
  petals.push([16 + 6.6 * Math.cos(a), 16 + 6.6 * Math.sin(a)]);
}

const raw = Buffer.alloc((S * 4 + 1) * S);
let p = 0;
for (let y = 0; y < S; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    const bgA = roundedRectAlpha(x, y, 8);
    if (bgA > 0) { r = BG[0]; g = BG[1]; b = BG[2]; a = 255 * bgA; }

    let fg = 0;
    for (const [cx, cy] of petals) fg = Math.max(fg, circleAlpha(x, y, cx, cy, 4.1));
    fg = Math.max(fg, circleAlpha(x, y, 16, 16, 2.6));

    if (fg > 0) {
      r = Math.round(r * (1 - fg) + FG[0] * fg);
      g = Math.round(g * (1 - fg) + FG[1] * fg);
      b = Math.round(b * (1 - fg) + FG[2] * fg);
      a = Math.max(a, 255 * fg);
    }
    raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = Math.round(a);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'tray.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
