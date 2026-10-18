import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 静态资产（会长头像 / 聊天背景）本地存储。
 *
 * DESIGN-DECISION（对齐酒馆）：一个角色 = 一张图。导入的角色卡 PNG 原图
 * 直接当头像存下来，不再像过去那样只取卡 JSON、把图丢掉。
 *
 * 存 data/ 而不是 public/：
 * - data/ 是存档，清档 / 换机会连资产一起走；
 * - Next 生产模式对运行时新增到 public/ 的文件不保证能服务。
 * 因此统一走 /api/assets/[kind]/[file] 读取。
 *
 * 文件名为随机 UUID（天然可作为长缓存键），DB 只存文件名。
 */

export type AssetKind = "avatar" | "background" | "scene";

const DIR_BY_KIND: Record<AssetKind, string> = {
  avatar: "avatars",
  background: "backgrounds",
  scene: "scenes",
};

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 单文件上限：本地自用，给足余量即可 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** 数据目录：与 SQLite 同处（DATABASE_PATH 可覆盖），保证换机 / 清档一致 */
export function dataDir(): string {
  if (process.env.DATABASE_PATH) return path.dirname(process.env.DATABASE_PATH);
  return path.join(process.cwd(), "data");
}

function assetDir(kind: AssetKind): string {
  const dir = path.join(dataDir(), DIR_BY_KIND[kind]);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 文件名安全：仅允许字母数字点横线下划线，且不得含路径分隔 / `..` */
export function isSafeAssetName(name: string): boolean {
  return name.length > 0 && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

/** 从原始文件名 / MIME 推断扩展名（白名单内），否则按 png */
export function pickExt(rawName: string, mime?: string): string {
  const ext = path.extname(rawName).toLowerCase();
  if (EXT_MIME[ext]) return ext;
  if (mime?.includes("jpeg") || mime?.includes("jpg")) return ".jpg";
  if (mime?.includes("webp")) return ".webp";
  if (mime?.includes("gif")) return ".gif";
  return ".png";
}

/** 保存资产，返回文件名 */
export function saveAsset(
  kind: AssetKind,
  bytes: Buffer,
  rawName = "",
  mime?: string,
): string {
  if (bytes.length === 0) throw new Error("文件是空的");
  if (bytes.length > MAX_ASSET_BYTES) throw new Error("文件太大了（上限 8MB）");
  const filename = `${randomUUID()}${pickExt(rawName, mime)}`;
  fs.writeFileSync(path.join(assetDir(kind), filename), bytes);
  return filename;
}

/** 解析资产绝对路径；不存在 / 名字不安全返回 null */
export function resolveAsset(kind: AssetKind, filename: string): string | null {
  if (!isSafeAssetName(filename)) return null;
  const filePath = path.join(assetDir(kind), filename);
  return fs.existsSync(filePath) ? filePath : null;
}

export function contentTypeFor(filename: string): string {
  return EXT_MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export function deleteAsset(
  kind: AssetKind,
  filename: string | null | undefined,
): void {
  if (!filename || !isSafeAssetName(filename)) return;
  try {
    fs.unlinkSync(path.join(assetDir(kind), filename));
  } catch {
    /* 已经不在就算了 */
  }
}

/** 资产的前端 URL（DB 存的是裸文件名） */
export function assetUrl(
  kind: AssetKind,
  filename: string | null | undefined,
): string | null {
  return filename ? `/api/assets/${kind}/${filename}` : null;
}

/**
 * 情景配图（本地生图）：直接以**消息 id** 为文件名存成 `<id>.png`。
 * 消息 id 是 randomUUID（安全字符），因此无需给 chat_log 加列——
 * 某条消息有没有配图，看这个文件在不在即可。
 */
export function saveScene(messageId: string, bytes: Buffer): string | null {
  if (!isSafeAssetName(messageId) || bytes.length === 0) return null;
  const filename = `${messageId}.png`;
  fs.writeFileSync(path.join(assetDir("scene"), filename), bytes);
  return filename;
}

/** 该消息已有配图则返回文件名，否则 null */
export function sceneFilename(messageId: string): string | null {
  if (!isSafeAssetName(messageId)) return null;
  const filename = `${messageId}.png`;
  return fs.existsSync(path.join(assetDir("scene"), filename)) ? filename : null;
}

/** 判断字节是否为 PNG（角色卡 PNG 的整张图就是头像） */
export function isPng(bytes: Buffer): boolean {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length > 8 && sig.every((b, i) => bytes[i] === b);
}
