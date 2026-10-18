import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db";
import { items, quests, settlementLog } from "../db/schema";
import { applyStreakBreak } from "../engine/streak";
import { REST_SCROLL_KEY } from "../shop";

/**
 * 定时任务纯函数层。
 *
 * 设计约束：
 * - 所有函数显式接收 `now: Date`，不在内部读系统时间 → 可单测（不依赖时钟）
 * - 不依赖任何 LLM
 * - 调度胶水在 scheduler.ts，本文件只负责"到点该做什么"
 * - 幂等：quests.last_checked_at 记录巡检痕迹，同一自然日内不重复惩罚
 *
 * 历史注：晨间推送/晚间提醒/推送触达层已随通知功能整体下线（V1.9），
 * 本层只剩与玩法强相关的逾期巡检（断签 + 休整卷轴保全）。
 */

export interface JobReport {
  /** 扫描到的任务数 */
  scanned: number;
  /** 本任务对数据库做的状态变更条数（如断签清零、卷轴消耗） */
  mutated: number;
}

function startOfDay(d: Date): number {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t.getTime();
}

function endOfDay(d: Date): number {
  const t = new Date(d);
  t.setHours(23, 59, 59, 999);
  return t.getTime();
}

// ---------------------------------------------------------------- 逾期巡检

export interface OverdueOptions {
  /** 仅在当天该小时执行（默认 1 点跑）；传 null 强制执行（测试用） */
  atHour?: number | null;
}

/**
 * 逾期巡检（断签软机制 + V1.5 休整卷轴）：
 * - 找出所有 status=active 的 daily 委托
 * - 昨日（自然日）内没有任何 quest_complete 结算记录 → 断签
 * - V1.5：持有休整卷轴则自动消耗一张，连击完全保全（streak/breakStreak 不动）
 * - 首次断签：break_streak=1，streak 保留（结算时加成减半由引擎体现）
 * - 连续第二天再断：streak 清零、break_streak 归零
 * - 断签任务置 status=overdue
 *
 * 幂等：quests.last_checked_at 记录本任务的巡检时间；同一次自然日内
 * 不重复惩罚同一任务（卷轴消耗因此也不会重复触发）。
 */
export async function runOverdueSweep(
  db: Db,
  now: Date,
  opts: OverdueOptions = {},
): Promise<JobReport> {
  const report: JobReport = { scanned: 0, mutated: 0 };
  const atHour = opts.atHour === undefined ? 1 : opts.atHour;
  if (atHour !== null && now.getHours() !== atHour) return report;

  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  const yStart = startOfDay(yesterday);
  const yEnd = endOfDay(yesterday);
  const todayStart = startOfDay(now);

  const candidates = db
  .select()
  .from(quests)
  .where(and(eq(quests.status, "active"), eq(quests.type, "daily")))
  .all();
  report.scanned = candidates.length;

  for (const q of candidates) {
  const yesterdaySettled =
  db
  .select({ id: settlementLog.id })
  .from(settlementLog)
  .where(
  and(
  eq(settlementLog.questId, q.id),
  eq(settlementLog.kind, "quest_complete"),
  gte(settlementLog.createdAt, yStart),
  lt(settlementLog.createdAt, yEnd + 1),
  ),
  )
  .all().length > 0;

  if (yesterdaySettled) {
  // 昨日有结算：清掉断签计数，任务保持 active
  if (q.breakStreak !== 0) {
  db.update(quests)
  .set({ breakStreak: 0, lastCheckedAt: now.getTime() })
  .where(eq(quests.id, q.id))
  .run();
  report.mutated += 1;
  }
  continue;
  }

  // 幂等保护：本自然日已经巡检过这条任务
  if (q.lastCheckedAt != null && q.lastCheckedAt >= todayStart) continue;

  // V1.5 休整卷轴：断签当晚自动消耗一张，
  // 连击完全保全（streak/breakStreak 不动，下次结算加成仍按原连击计算）；
  // 任务本身照常置 overdue——该没做还是没做，隔天补结算由 revive 拉回。
  const scroll = db
  .select()
  .from(items)
  .where(and(eq(items.userId, q.userId), eq(items.itemKey, REST_SCROLL_KEY)))
  .get();
  if (scroll && scroll.count > 0) {
  db.update(items)
  .set({ count: scroll.count - 1 })
  .where(eq(items.id, scroll.id))
  .run();
  db.update(quests)
  .set({ status: "overdue", lastCheckedAt: now.getTime() })
  .where(eq(quests.id, q.id))
  .run();
  report.mutated += 1;

  console.log(
  `[cron:overdue] 「${q.title}」断签被休整卷轴保全 → streak=${q.streak} ` +
  `scroll_left=${scroll.count - 1}`,
  );
  continue;
  }

  const consecutive = q.breakStreak + 1;
  const result = applyStreakBreak(q.streak, consecutive);
  db.update(quests)
  .set({
  streak: result.streak,
  breakStreak: result.reset ? 0 : consecutive,
  status: "overdue",
  lastCheckedAt: now.getTime(),
  })
  .where(eq(quests.id, q.id))
  .run();
  report.mutated += 1;

  // 开发期对账摘要
  console.log(
  `[cron:overdue] 「${q.title}」断签第 ${consecutive} 天 → streak=${result.streak} ` +
  `mult=${result.bonusMultiplier.toFixed(3)} reset=${result.reset}`,
  );
  }

  return report;
}

// -------------------------------------------------------------- 断签恢复

/**
 * 任务被重新结算时调用（由工具层在结算成功后触发）：
 * 把 overdue 任务拉回 active，并把 break_streak 归零。
 * 断签的 streak 数值由 runOverdueSweep 决定，此处不动 streak。
 */
export function reviveQuestAfterSettlement(db: Db, questId: string, now = Date.now()): void {
  db.update(quests)
  .set({ status: "active", breakStreak: 0, lastCheckedAt: now })
  .where(and(eq(quests.id, questId), eq(quests.status, "overdue")))
  .run();
}

/** 供对话层判断：该用户今日是否已有 active 委托（对账提醒的判据之一） */
export function countActiveQuests(db: Db, userId: string): number {
  return db
  .select({ id: quests.id })
  .from(quests)
  .where(and(eq(quests.userId, userId), eq(quests.status, "active")))
  .all().length;
}
