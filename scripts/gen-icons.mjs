/**
 * 生成 PWA 图标占位（pnpm icons）。
 * 没有设计资源时的自足方案：用纯色圆角底 + 门形剪影，纯 Node 手写 PNG，
 * 不引入图像库依赖。正式视觉到位后直接替换 public/icons/ 下的文件即可。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "public", "icons");

const BG = [26, 20, 16]; // #1a1410
const DOOR = [58, 42, 26]; // #3a2a1a
const LAMP = [232, 180, 90]; // #e8b45a
const FRAME = [107, 79, 46]; // #6b4f2e

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 门形协会标志：一盏灯、一扇门、一点透光 */
function render(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // 简单 alpha 混合（同色系叠加）
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  const cx = size / 2;
  const cy = size / 2;
  // maskable 需要 20% 安全边距
  const scale = maskable ? 0.62 : 0.78;
  const doorW = size * scale * 0.46;
  const doorH = size * scale * 0.68;
  const doorTop = cy - doorH / 2 + size * 0.02;
  const archRadius = doorW / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let color = BG;
      // 圆角底（maskable 时为满幅底）
      if (!maskable) {
        const r = size * 0.22;
        const dx = Math.max(r - x, 0, x - (size - r));
        const dy = Math.max(r - y, 0, y - (size - r));
        if (Math.hypot(dx, dy) > r) continue; // 透明角落
      }
      // 门体（下方矩形 + 上方半圆拱）
      const inRect =
        x >= cx - doorW / 2 &&
        x <= cx + doorW / 2 &&
        y >= doorTop + archRadius &&
        y <= doorTop + doorH;
      const inArch = Math.hypot(x - cx, y - (doorTop + archRadius)) <= archRadius;
      if (inRect || inArch) color = DOOR;
      // 门框
      if (inRect || inArch) {
        const edge =
          Math.abs(x - cx) > doorW / 2 - size * 0.02 ||
          y > doorTop + doorH - size * 0.02;
        if (edge) color = FRAME;
      }
      // 门缝透光
      if (x >= cx + doorW / 2 - size * 0.012 && (inRect || inArch)) color = LAMP;
      // 门楣上的灯
      const lampY = doorTop - size * 0.09;
      const lampR = size * 0.05;
      const d = Math.hypot(x - cx, y - lampY);
      if (d <= lampR) color = LAMP;
      else if (d <= lampR * 2.2 && !(inRect || inArch)) {
        // 灯光晕：向底色靠拢
        const t = 1 - (d - lampR) / (lampR * 1.2);
        color = [
          Math.round(BG[0] + (LAMP[0] - BG[0]) * t * 0.35),
          Math.round(BG[1] + (LAMP[1] - BG[1]) * t * 0.35),
          Math.round(BG[2] + (LAMP[2] - BG[2]) * t * 0.35),
        ];
      }
      set(x, y, color);
    }
  }
  return png(size, size, px);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon.png", 180, {}],
];
for (const [name, size, opts] of targets) {
  writeFileSync(path.join(OUT_DIR, name), render(size, opts));
  console.log(`[icons] ${name} (${size}×${size})`);
}
