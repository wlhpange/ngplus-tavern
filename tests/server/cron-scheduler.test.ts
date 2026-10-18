import { describe, it, expect } from "vitest";
import {
  CRON_EXPRESSIONS,
  isCronEnabled,
  isSchedulerRunning,
  startScheduler,
  stopScheduler,
} from "../../src/server/cron/scheduler";
import { createTestDb } from "../llm/helpers";
import { LOCAL_USER_ID } from "../../src/server/db/seed";

/**
 * 调度层只测"胶水"：开关语义、注册/取消、表达式形态。
 * 业务行为在 cron-jobs.test.ts（纯函数、可控时钟）。
 */

describe("CRON_ENABLED 开关（默认关闭）", () => {
  it("未设置 / 其他值 → 关闭；1 或 true → 开启", () => {
    expect(isCronEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isCronEnabled({ CRON_ENABLED: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isCronEnabled({ CRON_ENABLED: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isCronEnabled({ CRON_ENABLED: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isCronEnabled({ CRON_ENABLED: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("调度注册与取消", () => {
  it("startScheduler 注册任务后 isSchedulerRunning=true；stop 后可重入", () => {
    const { db } = createTestDb();
    expect(isSchedulerRunning()).toBe(false);
    const stop = startScheduler({ db, force: true, jobs: ["overdue"] });
    expect(isSchedulerRunning()).toBe(true);
    stop();
    expect(isSchedulerRunning()).toBe(false);
    stopScheduler(); // 重复取消不应抛错
    expect(isSchedulerRunning()).toBe(false);
  });

  it("重复 start 会先取消上一批（单实例）", () => {
    const { db } = createTestDb();
    startScheduler({ db, force: true, jobs: ["overdue"] });
    startScheduler({ db, force: true, jobs: ["overdue"] });
    expect(isSchedulerRunning()).toBe(true);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it("任务有合法 cron 表达式（5 段式）", () => {
    const names = Object.keys(CRON_EXPRESSIONS);
    expect(names).toEqual(["overdue"]);
    for (const expr of Object.values(CRON_EXPRESSIONS)) {
      expect(expr.trim().split(/\s+/)).toHaveLength(5);
    }
    // 逾期巡检固定在每天 01:00（此时"昨日"已完全过去）
    expect(CRON_EXPRESSIONS.overdue).toBe("0 1 * * *");
  });
});

describe("任务执行不依赖真实时钟/网络（可注入）", () => {
  it("注入 db 与 job 列表即可运行，不触碰真实数据外的资源", () => {
    const { db, userId } = createTestDb();
    expect(userId).toBe(LOCAL_USER_ID);
    const stop = startScheduler({ db, force: true, jobs: [] });
    expect(isSchedulerRunning()).toBe(true); // jobs=[] 也算已启动（无任务）
    stop();
  });
});
