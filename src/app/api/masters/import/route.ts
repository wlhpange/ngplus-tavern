import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { parseCardBytes, toImportedCard, type ImportedCard } from "@/server/cardImport";
import { createMasterFromCard } from "@/server/masters";
import { isPng, saveAsset } from "@/server/assets";
import { modelFromDb } from "@/server/modelConfig";
import { translateImportedCard, translationPreview } from "@/server/translate";

export const dynamic = "force-dynamic";

/**
 * P5/P11 导入角色卡（Character Card V1/V2/V3）。
 *
 * 两阶段：
 * - preview（multipart 上传文件）：只解析、不落库；返回卡名、spec、
 *   以及"有多少外语提示词需要翻译"。前端据此弹窗询问是否翻译成中文。
 * - commit（application/json：{ card, translate }）：把（可能已翻译的）卡落库。
 *
 * 兼容旧用法：未带 preview 标记的 multipart 直接落库（不翻译）。
 * CHARX（zip）暂不支持。
 */

async function readUpload(req: NextRequest): Promise<{ bytes: Buffer; filename: string } | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (file && typeof (file as File).arrayBuffer === "function") {
      const f = file as File;
      return { bytes: Buffer.from(await f.arrayBuffer()), filename: f.name ?? "" };
    }
    return null;
  }
  const body = (await req.json().catch(() => null)) as { json?: unknown } | null;
  if (typeof body?.json === "string") {
    return { bytes: Buffer.from(body.json, "utf8"), filename: "" };
  }
  return null;
}

/**
 * 酒馆式：角色卡 PNG 的整张图就是头像。上传的是 PNG 就顺手存下来。
 * 失败（超大等）不影响导入本身，返回 null。
 */
function saveCardAvatar(bytes: Buffer, filename: string): string | null {
  try {
    return isPng(bytes) ? saveAsset("avatar", bytes, filename, "image/png") : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const preview = url.searchParams.get("preview") === "1";
  const contentType = req.headers.get("content-type") ?? "";

  // ── commit 阶段：JSON 体 { card, translate } ──────────────────────────────
  if (contentType.includes("application/json") && !preview) {
    const body = (await req.json().catch(() => null)) as {
      card?: ImportedCard;
      translate?: boolean;
    } | null;
    if (!body?.card || typeof body.card !== "object") {
      return NextResponse.json({ error: "缺少 card" }, { status: 400 });
    }
    const { db, userId } = bootstrap();
    let card = body.card;
    let translated = { fields: 0, entries: 0 };
    if (body.translate) {
      try {
        const r = await translateImportedCard(modelFromDb(db), card);
        card = r.card;
        translated = { fields: r.translatedFields, entries: r.translatedEntries };
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? `翻译失败：${e.message}` : "翻译失败" },
          { status: 400 },
        );
      }
    }
    try {
      const created = createMasterFromCard(db, userId, card);
      return NextResponse.json({ ok: true, spec: card.spec, ...created, translated });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? `导入失败：${e.message}` : "导入失败" },
        { status: 400 },
      );
    }
  }

  // ── 解析上传 ──────────────────────────────────────────────────────────────
  let upload: { bytes: Buffer; filename: string } | null = null;
  try {
    upload = await readUpload(req);
  } catch {
    return NextResponse.json({ error: "上传内容无法读取" }, { status: 400 });
  }
  if (!upload || upload.bytes.length === 0) {
    return NextResponse.json({ error: "请选择一个角色卡文件（.json / .png）" }, { status: 400 });
  }

  let card: ImportedCard;
  try {
    card = toImportedCard(parseCardBytes(upload.bytes, upload.filename));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? `导入失败：${e.message}` : "导入失败" },
      { status: 400 },
    );
  }

  // ── preview 阶段：不落库，返回预览 ───────────────────────────────────────
  if (preview) {
    const pv = translationPreview(card);
    // 酒馆式：PNG 卡的整张图就是头像，先存下来，commit 成功后由前端回填
    const avatarFile = saveCardAvatar(upload.bytes, upload.filename);
    return NextResponse.json({
      ok: true,
      preview: {
        name: card.name,
        spec: card.spec,
        fields: pv.fields,
        entries: pv.entries,
        needed: pv.needed,
        avatarFile,
        card, // 前端原样带回 commit
      },
    });
  }

  // ── 兼容旧用法：直接落库（不翻译） ───────────────────────────────────────
  const { db, userId } = bootstrap();
  try {
    const avatar = saveCardAvatar(upload.bytes, upload.filename);
    const created = createMasterFromCard(db, userId, card, { avatar });
    return NextResponse.json({ ok: true, spec: card.spec, ...created, avatarFile: avatar });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? `导入失败：${e.message}` : "导入失败" },
      { status: 400 },
    );
  }
}
