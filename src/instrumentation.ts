/**
 * Next.js 启动钩子。register 在 dev / start 两种模式下都会执行，
 * 用于初始化 node-cron 定时任务（逾期巡检）。
 *
 * 这里刻意「直接引用具体文件」而不是 `import("./server/cron")`：
 * Next 14 的 instrumentation 会被拆成多个 webpack chunk，逐文件引入
 * 可让外部包映射与引用落在同一模块图内，避免构建期模块解析问题。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { isCronEnabled, startScheduler } = await import(
    "./server/cron/scheduler"
  );
  if (!isCronEnabled) {
    console.log("[cron] 未启用（设置 CRON_ENABLED=1 可启用逾期巡检）");
    return;
  }
  const { getDb } = await import("./server/db/index");
  const { ensureSeed, LOCAL_USER_ID } = await import("./server/db/seed");
  const db = getDb();
  ensureSeed(db, LOCAL_USER_ID);
  startScheduler({ db });
}
