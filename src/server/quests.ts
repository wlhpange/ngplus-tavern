import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import { quests } from "./db/schema";

/**
 * 委托动作（确定性，直连 API 不经 LLM）。
 * 「一键重挂」：把一件历史委托复制成新的**进行中**委托（V3 起跳过 proposed——
 * 用户在弹窗里确认过，直接开跑），参数照抄（属性/难度/签到标志），不复制日期与完成态。
 */

export type RepeatResult =
  | { ok: true; quest: { id: string; title: string; status: string } }
  | { ok: false; error: string };

/** 可以重挂的状态（进行中/待接受的不需要重挂；主线与里程碑不允许） */
const REPEATABLE = ["completed", "overdue", "abandoned", "rejected"] as const;

export function repeatQuest(
  db: Db,
  userId: string,
  questId: string,
  now = Date.now(),
): RepeatResult {
  const q = db
    .select()
    .from(quests)
    .where(and(eq(quests.id, questId), eq(quests.userId, userId)))
    .get();
  if (!q) return { ok: false, error: `找不到委托 ${questId}` };
  if (q.type === "mainline" || q.type === "mainline_milestone") {
    return { ok: false, error: "主线和里程碑不能一键重挂。" };
  }
  if (!(REPEATABLE as readonly string[]).includes(q.status)) {
    return { ok: false, error: `「${q.title}」还在进行中，不用重挂。` };
  }

  const id = randomUUID();
  db.insert(quests)
    .values({
      id,
      userId,
      title: q.title,
      description: q.description,
      type: q.type,
      category: q.category,
      primaryAttr: q.primaryAttr,
      primaryWeight: q.primaryWeight,
      secondaryAttr: q.secondaryAttr,
      secondaryWeight: q.secondaryWeight,
      attrReason: q.attrReason,
      difficulty: q.difficulty,
      // V3：确认后直接进行中（不再走 proposed → 对话接受）
      status: "active",
      streak: 0,
      checkin: q.checkin,
      deadline: null,
      parentQuestId: null,
      createdAt: now,
    })
    .run();

  return { ok: true, quest: { id, title: q.title, status: "active" } };
}
