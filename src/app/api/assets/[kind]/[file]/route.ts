import { NextRequest } from "next/server";
import fs from "node:fs";
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
  const bytes = fs.readFileSync(filePath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentTypeFor(params.file),
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
