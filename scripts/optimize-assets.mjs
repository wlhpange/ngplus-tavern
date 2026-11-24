#!/usr/bin/env node
/**
 * 一次性资产瘦身脚本（可选运行）：
 *   node scripts/optimize-assets.mjs [--dry-run]
 *
 * - data/avatars、data/backgrounds：原地重新编码（保持原扩展名，不动数据库）。
 * - data/scenes：<消息id>.png/.jpg → <消息id>.webp，删掉旧文件。
 *   配图文件名由消息 id 推导，没有数据库引用，转换是安全的。
 *
 * 运行前请先备份 data/（脚本不会删除原图以外的任何东西）。
 * 只处理本地常见图片格式；GIF 可能是动图，跳过。
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DRY = process.argv.includes("--dry-run");
const dataDir = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(process.cwd(), "data");

const AVATAR_EDGE = 512;
const BACKGROUND_EDGE = 1920;
const SCENE_EDGE = 1280;
const QUALITY = 82;

const dirs = {
  avatar: path.join(dataDir, "avatars"),
  background: path.join(dataDir, "backgrounds"),
  scene: path.join(dataDir, "scenes"),
};

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

function fmt(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

async function reencodeInPlace(dir, file, edge) {
  const full = path.join(dir, file);
  const ext = path.extname(file).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return null;
  const before = fs.statSync(full).size;
  const meta = await sharp(full, { failOn: "none" }).metadata();
  if (meta.format === "gif") return null;
  const width = meta.width ?? edge;
  const height = meta.height ?? edge;
  const scale = Math.min(1, edge / Math.max(width, height));
  if (scale === 1 && ext === ".webp" && before < 300 * 1024) return null;

  let pipe = sharp(full, { failOn: "none" })
    .rotate()
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      fit: "inside",
      withoutEnlargement: true,
    });
  if (ext === ".png") pipe = pipe.png({ compressionLevel: 9 });
  else if (ext === ".webp") pipe = pipe.webp({ quality: QUALITY, effort: 4 });
  else pipe = pipe.jpeg({ quality: QUALITY, mozjpeg: true });

  const out = await pipe.toBuffer();
  if (out.length >= before) return null;
  if (!DRY) fs.writeFileSync(full, out);
  return { before, after: out.length };
}

async function convertScene(file) {
  const full = path.join(dirs.scene, file);
  const ext = path.extname(file).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(ext)) return null;
  const id = path.basename(file, ext);
  const target = path.join(dirs.scene, `${id}.webp`);
  const before = fs.statSync(full).size;
  const out = await sharp(full, { failOn: "none" })
    .rotate()
    .resize({ width: SCENE_EDGE, height: SCENE_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: QUALITY, effort: 4 })
    .toBuffer();
  if (out.length >= before) return null;
  if (!DRY) {
    fs.writeFileSync(target, out);
    fs.unlinkSync(full);
  }
  return { before, after: out.length };
}

let totalBefore = 0;
let totalAfter = 0;
let changed = 0;

async function run() {
  for (const [kind, dir] of [
    ["avatar", dirs.avatar],
    ["background", dirs.background],
  ]) {
    const edge = kind === "avatar" ? AVATAR_EDGE : BACKGROUND_EDGE;
    for (const file of listFiles(dir)) {
      try {
        const r = await reencodeInPlace(dir, file, edge);
        if (!r) continue;
        changed += 1;
        totalBefore += r.before;
        totalAfter += r.after;
        console.log(`[${kind}] ${file}: ${fmt(r.before)} → ${fmt(r.after)}`);
      } catch (e) {
        console.warn(`[${kind}] 跳过 ${file}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  for (const file of listFiles(dirs.scene)) {
    try {
      const r = await convertScene(file);
      if (!r) continue;
      changed += 1;
      totalBefore += r.before;
      totalAfter += r.after;
      console.log(`[scene] ${file}: ${fmt(r.before)} → ${fmt(r.after)}`);
    } catch (e) {
      console.warn(`[scene] 跳过 ${file}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(
    `\n${DRY ? "[dry-run] " : ""}完成：${changed} 个文件，` +
      `${fmt(totalBefore)} → ${fmt(totalAfter)}`,
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
