/**
 * 共享时间工具。
 * DESIGN-DECISION: 自然日边界统一用服务器本地时区的 00:00（与 cron 巡检、
 * 面板「今日已结算」口径一致）。cron 层的 startOfDay(d: Date) 是纯函数变体
 * （显式传入时间以便测试），不收编到此处。
 */

/** 今日零点（本地时区）的时间戳 */
export function startOfToday(): number {
  return startOfDayTs(new Date());
}

/** 任意时刻所在的自然日零点 */
export function startOfDayTs(d: Date): number {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t.getTime();
}

/** 所在月的 1 日零点（本地时区） */
export function startOfMonth(d: Date = new Date()): number {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  t.setDate(1);
  return t.getTime();
}

/** 所在周（周一为一周之始）的零点 */
export function startOfWeek(d: Date = new Date()): number {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  const dow = t.getDay(); // 0=周日
  const diff = dow === 0 ? 6 : dow - 1;
  t.setDate(t.getDate() - diff);
  return t.getTime();
}

/** 周标识（该周周一的日期，如 2026-09-21），用于周常 Boss 的每周去重 */
export function weekKey(d: Date = new Date()): string {
  const monday = new Date(startOfWeek(d));
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}
