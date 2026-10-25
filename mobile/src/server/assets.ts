import { Directory, File, Paths } from "expo-file-system";
import { randomUUID } from "./util/id";

/**
 * 静态资产（会长头像 / 聊天背景 / 情景配图）本地存储。
 * 移动端把文件写进 App 私有 documents/assets/<kind>/，DB 只存裸文件名。
 * 原生等价物：Web 的 /api/assets 路由由 file:// URI 直接交给 <Image>。
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

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function assetDir(kind: AssetKind): Directory {
  const dir = new Directory(Paths.document, "assets", DIR_BY_KIND[kind]);
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  return dir;
}

export function isSafeAssetName(name: string): boolean {
  return name.length > 0 && /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

export function pickExt(rawName: string, mime?: string): string {
  const m = rawName.match(/\.[A-Za-z0-9]+$/);
  const ext = (m?.[0] ?? "").toLowerCase();
  if (EXT_MIME[ext]) return ext;
  if (mime?.includes("jpeg") || mime?.includes("jpg")) return ".jpg";
  if (mime?.includes("webp")) return ".webp";
  if (mime?.includes("gif")) return ".gif";
  return ".png";
}

export function saveAsset(
  kind: AssetKind,
  bytes: Uint8Array,
  rawName = "",
  mime?: string,
): string {
  if (bytes.length === 0) throw new Error("文件是空的");
  if (bytes.length > MAX_ASSET_BYTES) throw new Error("文件太大了（上限 8MB）");
  const filename = `${randomUUID()}${pickExt(rawName, mime)}`;
  const file = new File(assetDir(kind), filename);
  file.writeSync(bytes);
  return filename;
}

/** 返回 file:// URI；不存在 / 名字不安全返回 null */
export function resolveAsset(kind: AssetKind, filename: string): string | null {
  if (!isSafeAssetName(filename)) return null;
  const file = new File(assetDir(kind), filename);
  return file.exists ? file.uri : null;
}

export function contentTypeFor(filename: string): string {
  const m = filename.match(/\.[A-Za-z0-9]+$/);
  return EXT_MIME[(m?.[0] ?? "").toLowerCase()] ?? "application/octet-stream";
}

export function deleteAsset(kind: AssetKind, filename: string | null | undefined): void {
  if (!filename || !isSafeAssetName(filename)) return;
  try {
    const file = new File(assetDir(kind), filename);
    if (file.exists) file.delete();
  } catch {
    /* 已经不在就算了 */
  }
}

/** 前端可直接用于 <Image source={{ uri }}> 的 file:// URI */
export function assetUrl(
  kind: AssetKind,
  filename: string | null | undefined,
): string | null {
  if (!filename) return null;
  return resolveAsset(kind, filename);
}

export function saveScene(messageId: string, bytes: Uint8Array): string | null {
  if (!isSafeAssetName(messageId) || bytes.length === 0) return null;
  const filename = `${messageId}.png`;
  new File(assetDir("scene"), filename).writeSync(bytes);
  return filename;
}

export function sceneFilename(messageId: string): string | null {
  if (!isSafeAssetName(messageId)) return null;
  const filename = `${messageId}.png`;
  return new File(assetDir("scene"), filename).exists ? filename : null;
}

export function isPng(bytes: Uint8Array): boolean {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length > 8 && sig.every((b, i) => bytes[i] === b);
}
