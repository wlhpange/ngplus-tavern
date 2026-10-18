// node-cron v4 是纯 ESM 包、无 default 导出，用具名 schedule
import { schedule as cronSchedule, type ScheduledTask } from "node-cron";
import type { Db } from "../db";
import { getDb } from "../db";
import { runOverdueSweep, type JobReport } from "./jobs";

/**
 * node-cron 调度器。
 *
 * 调度时间（本地时区）：
 * - 逾期巡检：每天 01:00，判定「昨日断签」（此时昨日已完全过去）
 *
 * 历史注：晨间推送/晚间提醒已随通知功能下线（V1.9）。
 *
 * 进程内单例：Next.js 热重载/多实例下用 globalThis 防止重复注册。
 */

/** 任务的 cron 表达式（5 段式） */
export const CRON_EXPRESSIONS = {
  overdue: "0 1 * * *",
} as const;

export type JobName = keyof typeof CRON_EXPRESSIONS;

const JOB_LABEL: Record<JobName, string> = {
  overdue: "逾期巡检（断签）",
};

interface CronRegistry {
  tasks: ScheduledTask[];
  started: boolean;
}

const globalKey = "__ngplus_cron__";
function registry(): CronRegistry {
  const g = globalThis as unknown as Record<string, CronRegistry | undefined>;
  if (!g[globalKey]) g[globalKey] = { tasks: [], started: false };
  return g[globalKey]!;
}

/** 是否已启用（环境变量 CRON_ENABLED=1/true）；未启用时调度器不注册任何任务 */
export function isCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRON_ENABLED === "1" || env.CRON_ENABLED === "true";
}

export function isSchedulerRunning(): boolean {
  return registry().started;
}

export interface SchedulerOptions {
  db?: Db;
  /** 只注册指定任务（测试用）；默认全部 */
  jobs?: JobName[];
  /** 单次执行结果回调（日志/测试观察） */
  onResult?: (job: JobName, report: JobReport) => void;
  /**
  * 显式绕过 CRON_ENABLED 开关（仅供测试）。
  * DESIGN-DECISION: 生产路径永远走环境变量；给测试留一个显式逃生口，
  * 好过让测试去改 process.env（会污染同进程其他用例）。
  */
  force?: boolean;
}

/**
 * 注册定时任务（不立即执行）。返回取消函数。
 * 未启用 CRON_ENABLED 时返回 no-op，不占用任何资源。
 */
export function startScheduler(opts: SchedulerOptions = {}): () => void {
  if (!opts.force && !isCronEnabled()) {
  console.log("[cron] CRON_ENABLED 未开启，跳过定时任务注册");
  return () => {};
  }
  const reg = registry();
  if (reg.started) return stopScheduler;
  reg.started = true;

  const db = opts.db ?? getDb();
  const jobs = opts.jobs ?? (Object.keys(CRON_EXPRESSIONS) as JobName[]);

  const runners: Record<JobName, () => Promise<JobReport>> = {
  overdue: () => runOverdueSweep(db, new Date()),
  };

  for (const job of jobs) {
  reg.tasks.push(
  cronSchedule(CRON_EXPRESSIONS[job], async () => {
  try {
  const report = await runners[job]();
  console.log(
  `[cron:${job}] ${JOB_LABEL[job]} scanned=${report.scanned} mutated=${report.mutated}`,
  );
  opts.onResult?.(job, report);
  } catch (e) {
  // 定时任务绝不能因单次异常退出调度循环
  console.error(`[cron:${job}] 执行失败`, e);
  }
  }),
  );
  }

  console.log(`[cron] 已启动 jobs=${jobs.join(",")}`);
  return stopScheduler;
}

/** 停止全部任务（测试/优雅退出用）；重复调用安全 */
export function stopScheduler(): void {
  const reg = registry();
  for (const t of reg.tasks) {
    try {
      t.stop();
    } catch {
      // 忽略：已停止/已销毁的句柄
    }
  }
  reg.tasks = [];
  reg.started = false;
}
