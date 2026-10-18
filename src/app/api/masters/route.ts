import { NextResponse } from "next/server";
import { bootstrap } from "@/server/bootstrap";
import { getSaveState, listSelectableMasters } from "@/server/masters";
import { assetUrl } from "@/server/assets";
import { cardIntroText } from "@/lib/labels";

export const dynamic = "force-dynamic";

/** 形象参数以 JSON 字符串存库；解析失败按未设置处理 */
function parseSprite(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** 官方人格列表 + 当前存档状态（选人界面数据源） */
export async function GET() {
  const { db, userId } = bootstrap();
  const saveState = getSaveState(db, userId);
  return NextResponse.json({
    masters: listSelectableMasters(db, userId).map((m) => {
      // 卡面简介清洗：掐掉 [Personality=...] / <START> / {{user}} 这类模板污染
      const selfIntro = cardIntroText(m.persona, 120);
      // 背景行：有可读内容才显示；失败退回简介（前端再判重）
      const backstory = cardIntroText(
        {
          self_intro: m.persona.backstory?.trim() || undefined,
          description: m.persona.description,
          first_mes: m.persona.first_mes,
          tags: m.persona.tags,
        },
        160,
      );
      return {
        id: m.id,
        name: m.name,
        avatar: assetUrl("avatar", m.avatar),
        sprite: parseSprite(m.sprite),
        selfIntro,
        backstory: backstory === selfIntro ? "" : backstory,
        tags: m.persona.tags ?? [],
        isOfficial: m.isOfficial,
        isCustom: m.isCustom,
      };
    }),
    activeMasterId: saveState?.activeMasterId ?? null,
    intimacyLabel: saveState?.intimacyLabel ?? "初识",
  });
}
