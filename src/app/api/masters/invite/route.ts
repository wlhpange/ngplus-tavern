import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { bootstrap } from "@/server/bootstrap";
import { createCustomMaster } from "@/server/masters";
import { modelFromDb } from "@/server/modelConfig";
import { PersonaForgeSchema } from "@/server/personaForge";

export const dynamic = "force-dynamic";

/**
 * V1.9 指名邀请（第五扇门）：用户指名任意角色来执掌协会。
 * LLM 把用户的一段描述锻造成结构化人格卡（master-persona-design.md §3），
 * createCustomMaster 校验落库；随后前端走既有的 activate 完成上岗。
 * 锻造失败（无 Key/网络/结构不符）→ 400 友好文案，不产生任何半成品数据。
 *
 * 注：V2.0 起前端「新增会长」改用 /api/masters/forge（按已填字段补全、先回填表单）；
 * 本接口保留给旧调用方与测试。schema 与 forge 共用（server/personaForge.ts）。
 */

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    brief?: string;
    avatar?: string | null;
  } | null;
  const name = body?.name?.trim() ?? "";
  const brief = body?.brief?.trim() ?? "";
  const avatar = body?.avatar?.trim() || null;
  if (!name || name.length > 12) {
    return NextResponse.json({ error: "名字要在 1 到 12 个字之间" }, { status: 400 });
  }
  if (brief.length < 5 || brief.length > 300) {
    return NextResponse.json(
      { error: "描述写 5 到 300 字：给协会一点关于 ta 的线索" },
      { status: 400 },
    );
  }

  const { db, userId } = bootstrap();
  try {
    const { object } = await generateObject({
      model: modelFromDb(db),
      schema: PersonaForgeSchema,
      system: [
        "你是「二周目协会」的人格锻造师。用户指名一位角色来执掌这间协会，",
        "你根据用户的描述，为 ta 锻造一张可直接使用的会长人格卡。",
        "世界观：二周目协会是一间专为「想重新开始的人生」服务的小协会，会长像朋友而非客服，",
        "身上带一点未解的谜。性格要鲜明、有缺口，不要完美圣人。",
        "所有文字用中文；catchphrases 是口头禅（1–3 条）；sample_dialogues 给 2–3 段不同场景的说话样例；",
        "relationship_stages 固定三档（stage 1/2/3），给出每档的 label（阶段名，可以按角色风格另起）、address（怎么称呼用户）与 tone_note（语气要点）。",
        "description 是一段 2–3 句的人物速写（别人眼中的 ta）；scenario 是一句「此刻你们在哪里、在做什么」的场景设定；",
        "first_mes 是 ta 见到用户时说的第一句话（1–2 句，要有角色的味道，不要问候模板）；alternate_greetings 给 1–2 条备选开场；tags 给 1–3 个短标签。",
      ].join("\n"),
      prompt: `【会长名字】${name}\n【用户的描述】${brief}`,
      abortSignal: AbortSignal.timeout(60_000),
    });

    const created = createCustomMaster(db, userId, {
      name,
      brief,
      avatar,
      persona: {
        self_intro: object.self_intro,
        personality: object.personality,
        speech: object.speech,
        backstory: object.backstory,
        mystery_hooks: object.mystery_hooks,
        sample_dialogues: object.sample_dialogues,
        relationship_stages: object.relationship_stages,
        description: object.description,
        scenario: object.scenario,
        first_mes: object.first_mes,
        alternate_greetings: object.alternate_greetings,
        tags: object.tags,
      },
    });

    return NextResponse.json({ ok: true, masterId: created.id, name: created.name });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `协会没能把 ta 请来：${e.message.slice(0, 160)}`
            : "协会没能把 ta 请来，请再试一次。",
      },
      { status: 400 },
    );
  }
}
