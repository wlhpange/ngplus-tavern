import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

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

/**
 * 各类资产的最大长边。
 * 头像只显示 28~40px，背景铺满手机屏，配图在灯箱里看——
 * 原图往往是 1~4MB 的角色卡/相机图，直接下发太浪费移动端流量。
 */
const MAX_EDGE: Record<AssetKind, number> = {
  avatar: 512,
  background: 1920,
  scene: 1280,
};
const WEBP_QUALITY = 82;

/** 压缩 + 转 WebP；GIF（可能是动图）与无法解析的格式原样保留 */
async function optimizeImage(
  kind: AssetKind,
  bytes: Buffer,
  fallbackExt: string,
): Promise<{ data: Buffer; ext: string }> {
  try {
    const image = sharp(bytes, { failOn: "none" });
    const meta = await image.metadata();
    if (meta.format === "gif") return { data: bytes, ext: ".gif" };

    const width = meta.width ?? MAX_EDGE[kind];
    const height = meta.height ?? MAX_EDGE[kind];
    const maxEdge = MAX_EDGE[kind];
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    // 已经够小且就是 WebP：没必要重编码
    if (scale === 1 && meta.format === "webp" && bytes.length < 300 * 1024) {
      return { data: bytes, ext: ".webp" };
    }

    const data = await sharp(bytes, { failOn: "none" })
      .rotate() // 尊重 EXIF 方向
      .resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY, effort: 4 })
      .toBuffer();

    // 极端情况（小尺寸 PNG 线稿）WebP 可能更大：不压缩反而更划算
    if (scale === 1 && data.length >= bytes.length) {
      return { data: bytes, ext: fallbackExt };
    }
    return { data, ext: ".webp" };
  } catch {
    // 不认识的格式：保持原样，至少不影响上传
    return { data: bytes, ext: fallbackExt };
  }
}

/** 保存资产（压缩为 WebP），返回文件名 */
export async function saveAsset(
  kind: AssetKind,
  bytes: Buffer,
  rawName = "",
  mime?: string,
): Promise<string> {
  if (bytes.length === 0) throw new Error("文件是空的");
  if (bytes.length > MAX_ASSET_BYTES) throw new Error("文件太大了（上限 8MB）");
  const { data, ext } = await optimizeImage(kind, bytes, pickExt(rawName, mime));
  const filename = `${randomUUID()}${ext}`;
  fs.writeFileSync(path.join(assetDir(kind), filename), data);
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
  if (kind === "scene") invalidateSceneFiles();
}

/** 资产的前端 URL（DB 存的是裸文件名） */
export function assetUrl(
  kind: AssetKind,
  filename: string | null | undefined,
): string | null {
  return filename ? `/api/assets/${kind}/${filename}` : null;
}

/**
 * 情景配图（本地生图）：直接以**消息 id** 为文件名存成 `<id>.webp`（旧档可能是 .png）。
 * 消息 id 是 randomUUID（安全字符），因此无需给 chat_log 加列——
 * 某条消息有没有配图，看这个文件在不在即可。
 */
export async function saveScene(messageId: string, bytes: Buffer): Promise<string | null> {
  if (!isSafeAssetName(messageId) || bytes.length === 0) return null;
  const { data, ext } = await optimizeImage("scene", bytes, ".png");
  const filename = `${messageId}${ext}`;
  fs.writeFileSync(path.join(assetDir("scene"), filename), data);
  // 同一消息重新生成时清掉旧扩展名，避免目录里留下两份
  for (const oldExt of [".png", ".jpg", ".jpeg", ".webp"]) {
    if (oldExt !== ext) deleteAsset("scene", `${messageId}${oldExt}`);
  }
  invalidateSceneFiles();
  return filename;
}

/** 配图目录的短缓存：对话页一次请求要判几百条消息，逐个 existsSync 太浪费 */
let _sceneFiles: { at: number; files: Map<string, string> } | null = null;
const SCENE_FILES_TTL_MS = 2000;

export function invalidateSceneFiles(): void {
  _sceneFiles = null;
}

/**
 * 当前已落盘的配图（消息 id → 文件名）。
 * 目录扫描只做一次，2 秒内复用；生成/删除时主动失效，保证刷新即时可见。
 */
export function listSceneFiles(now = Date.now()): Map<string, string> {
  if (_sceneFiles && now - _sceneFiles.at < SCENE_FILES_TTL_MS) return _sceneFiles.files;
  const files = new Map<string, string>();
  try {
    for (const name of fs.readdirSync(assetDir("scene"))) {
      const dot = name.lastIndexOf(".");
      if (dot <= 0) continue;
      const ext = name.slice(dot).toLowerCase();
      const rank =
        ext === ".webp" ? 4 : ext === ".jpg" || ext === ".jpeg" ? 3 : ext === ".png" ? 2 : 0;
      if (rank === 0) continue;
      const id = name.slice(0, dot);
      const prev = files.get(id);
      const prevRank = prev ? (prev.endsWith(".webp") ? 4 : 3) : 0;
      if (!prev || rank > prevRank) files.set(id, name);
    }
  } catch {
    /* 目录不存在 = 还没配过图 */
  }
  _sceneFiles = { at: now, files };
  return files;
}

/** 该消息已有配图则返回文件名，否则 null（新档 .webp，旧档 .png 继续兼容） */
export function sceneFilename(messageId: string): string | null {
  if (!isSafeAssetName(messageId)) return null;
  for (const ext of [".webp", ".jpg", ".jpeg", ".png"]) {
    const filename = `${messageId}${ext}`;
    if (fs.existsSync(path.join(assetDir("scene"), filename))) return filename;
  }
  return null;
}

/** 判断字节是否为 PNG（角色卡 PNG 的整张图就是头像） */
export function isPng(bytes: Buffer): boolean {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length > 8 && sig.every((b, i) => bytes[i] === b);
}
