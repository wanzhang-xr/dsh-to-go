'use strict';
/**
 * make-icon.js —— 从 assets/app-icon.svg 生成 assets/app.ico
 *
 *   runtime\node\node.exe tools\launcher\make-icon.js
 *
 * 为什么要脚本而不是手放一个 .ico：图标要的是「可复现」。改 SVG 之后重跑一次，
 * 七个尺寸的 .ico 就重新生成，不用再手工拼。
 *
 * 渲染方式：用系统的 Edge 无头模式把 SVG 以精确像素栅格化（透明背景）。
 *
 * 帧格式很关键：**小尺寸必须是 BMP(DIB)，不能全是 PNG**。
 * PNG 帧虽然从 Vista 起就合法，但资源管理器/任务栏在 16/24/32/48 这些尺寸上
 * 读 PNG 帧经常失败，于是回退成 Windows 的「通用程序」图标（白窗+红黄蓝色块）——
 * 你看到的那个图标就是它。所以这里 ≤64 一律转成 32bpp BMP，只有 128/256 用 PNG
 * （大图标用 PNG 省体积，且系统对大尺寸 PNG 帧支持得最好）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SVG = path.join(ROOT, 'assets', 'app-icon.svg');
const OUT = path.join(ROOT, 'assets', 'app.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const DIB_MAX = 64; // ≤ 这个尺寸用 BMP，其余用 PNG

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome，无法栅格化 SVG');
}

function renderIt(browser, svg, size, outPng, workDir) {
  const html = path.join(workDir, 'icon-' + size + '.html');
  fs.writeFileSync(html,
    '<!doctype html><meta charset=utf-8><style>html,body{margin:0;padding:0;background:transparent}'
    + 'svg{display:block}</style>' + svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" '), 'utf8');
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--default-background-color=00000000',
    '--force-device-scale-factor=1',
    '--window-size=' + size + ',' + size,
    '--screenshot=' + outPng,
    'file:///' + html.replace(/\\/g, '/'),
  ];
  const r = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (!fs.existsSync(outPng)) throw new Error('渲染失败（' + size + 'px）：' + (r.stderr || '').slice(0, 300));
  const buf = fs.readFileSync(outPng);
  if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('输出不是 PNG：' + outPng);
  return buf;
}

/** 极简 PNG 解码：只处理 Chrome 截图会产出的 8bit RGBA / RGB、非隔行。 */
function pngToRgba(buf) {
  if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('不是 PNG');
  let off = 8;
  let w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('只支持 8bit RGB/RGBA PNG（拿到 depth=' + depth + ' colorType=' + colorType + '）');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 0xff;
      } else if (filter !== 0) throw new Error('未知 PNG filter ' + filter);
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev);
  }
  return { rgba: out, width: w, height: h };
}

/** RGBA → ICO 用的 32bpp BMP（BITMAPINFOHEADER + 自底向上 BGRA + AND 掩码）。 */
function toDib(rgba, w, h) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // biSize
  header.writeInt32LE(w, 4);            // biWidth
  header.writeInt32LE(h * 2, 8);        // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);          // biPlanes
  header.writeUInt16LE(32, 14);         // biBitCount
  header.writeUInt32LE(0, 16);          // BI_RGB
  header.writeUInt32LE(w * h * 4, 20);  // biSizeImage
  const xor = Buffer.alloc(w * h * 4);
  const maskStride = Math.ceil(w / 32) * 4;
  const and = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y; // BMP 自底向上
    for (let x = 0; x < w; x++) {
      const s = (srcRow * w + x) * 4;
      const d = (y * w + x) * 4;
      xor[d] = rgba[s + 2];     // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s];     // R
      const alpha = rgba[s + 3];
      xor[d + 3] = alpha;
      if (alpha === 0) {
        const rowBase = y * maskStride + (x >> 3);
        and[rowBase] |= 0x80 >> (x & 7); // 1 = 透明
      }
    }
  }
  return Buffer.concat([header, xor, and]);
}

function buildIco(frames) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += f.data.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

const svg = fs.readFileSync(SVG, 'utf8');
const browser = findBrowser();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-icon-'));
const frames = [];
for (const size of SIZES) {
  const png = path.join(workDir, 'icon-' + size + '.png');
  const buf = renderIt(browser, svg, size, png, workDir);
  if (size <= DIB_MAX) {
    const img = pngToRgba(buf);
    if (img.width !== size || img.height !== size) {
      throw new Error('渲染尺寸不对：要 ' + size + '，拿到 ' + img.width + 'x' + img.height);
    }
    const dib = toDib(img.rgba, img.width, img.height);
    frames.push({ size, data: dib });
    console.log('  ' + size + 'px  BMP ' + dib.length + ' bytes');
  } else {
    frames.push({ size, data: buf });
    console.log('  ' + size + 'px  PNG ' + buf.length + ' bytes');
  }
}
const ico = buildIco(frames);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);
console.log('已生成 ' + path.relative(ROOT, OUT) + '：' + ico.length + ' 字节（' + frames.length + ' 帧，'
  + frames.filter((f) => f.size <= DIB_MAX).length + ' BMP + ' + frames.filter((f) => f.size > DIB_MAX).length + ' PNG）');
