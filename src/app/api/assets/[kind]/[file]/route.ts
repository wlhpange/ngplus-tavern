import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { contentTypeFor, resolveAsset, type AssetKind } from "@/server/assets";

export const dynamic = "force-dynamic";

/** 读取本机资产（会长头像 / 聊天背景）。文件名为 UUID，可长缓存。 */

const KINDS: AssetKind[] = ["avatar", "background", "scene"];

function parseKind(value: string): AssetKind | null {
  return (KINDS as string[]).includes(value) ? (value as AssetKind) : null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { kind: string; file: string } },
) {
  const kind = parseKind(params.kind);
  if (!kind) return new Response("Not found", { status: 404 });
  const filePath = resolveAsset(kind, params.file);
  if (!filePath) return new Response("Not found", { status: 404 });

  // 流式返回而不是整读进内存：头像/背景/配图上限 8MB，
  // 同步 readFileSync 会阻塞事件循环，同进程的 SSE 流式回复会一起卡住。
  const info = await stat(filePath).catch(() => null);
  if (!info) return new Response("Not found", { status: 404 });

  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": contentTypeFor(params.file),
      "Content-Length": String(info.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
