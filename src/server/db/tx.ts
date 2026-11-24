import type { Db } from "./index";

/**
 * 同步事务包装（better-sqlite3 是同步驱动，drizzle 的 transaction 也是同步的）。
 *
 * 为什么需要：结算 / 复核 / 购买这类操作会连续写多张表
 * （character、quests、settlement_log、titles、memory…）。
 * 没有事务时，中途抛错会留下「经验涨了但委托没完成」这类半更新状态；
 * 而调用方的失败处理只回滚聊天留痕，不会回滚账本。
 *
 * 注意：回调里不要 await（await 会让出事件循环，事务长时间占着写锁）；
 * LLM 调用等异步动作必须放在事务外。
 */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(() => fn());
}
