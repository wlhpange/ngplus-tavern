import { NextRequest, NextResponse } from "next/server";
import { saveAsset, type AssetKind } from "@/server/assets";

export const dynamic = "force-dynamic";

/**
 * 上传一份本地资产（会长头像 / 聊天背景）。
 * multipart：file=文件；?kind=avatar|background。返回 { file }（存进 DB 的裸文件名）。
 */

const KINDS: AssetKind[] = ["avatar", "background", "scene"];

export async function POST(req: NextRequest) {
  const kindParam = req.nextUrl.searchParams.get("kind") ?? "";
  if (!(KINDS as string[]).includes(kindParam)) {
    return NextResponse.json({ error: "未知的资产类型" }, { status: 400 });
  }
  const kind = kindParam as AssetKind;

  let bytes: Buffer;
  let filename = "";
  let mime = "";
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof (file as File).arrayBuffer !== "function") {
      return NextResponse.json({ error: "请选择一个文件" }, { status: 400 });
    }
    const f = file as File;
    bytes = Buffer.from(await f.arrayBuffer());
    filename = f.name ?? "";
    mime = f.type ?? "";
  } catch {
    return NextResponse.json({ error: "上传内容无法读取" }, { status: 400 });
  }

  try {
    const saved = saveAsset(kind, bytes, filename, mime);
    return NextResponse.json({ ok: true, file: saved });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存失败" },
      { status: 400 },
    );
  }
}
