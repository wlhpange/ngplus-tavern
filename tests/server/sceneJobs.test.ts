import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../llm/helpers";
import type { Db } from "../../src/server/db";
import {
  startSceneJob,
  getSceneJob,
  isSceneGenerating,
  cancelSceneJob,
  __resetSceneJobs,
  type SceneWork,
} from "../../src/server/image/jobs";

let db: Db;

beforeEach(() => {
  ({ db } = createTestDb());
  __resetSceneJobs();
});

const msg = (id: string) => ({ id, content: "内容", masterId: null, sessionId: null });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("配图后台任务（与请求解耦）", () => {
  it("启动后即为生成中；成功后记录清除（以文件为准）", async () => {
    const job = startSceneJob(db, "u", msg("m1"), undefined, async () => {});
    expect(["queued", "running"]).toContain(job.status);
    expect(isSceneGenerating("m1")).toBe(true);
    await tick();
    expect(isSceneGenerating("m1")).toBe(false);
    expect(getSceneJob("m1")).toBeUndefined();
  });

  it("失败时保留错误状态与信息", async () => {
    startSceneJob(db, "u", msg("m2"), undefined, async () => {
      throw new Error("boom");
    });
    await tick();
    const j = getSceneJob("m2");
    expect(j?.status).toBe("error");
    expect(j?.error).toContain("boom");
    expect(isSceneGenerating("m2")).toBe(false);
  });

  it("同一消息重复点击返回同一任务（幂等）", async () => {
    let release: () => void = () => {};
    const work: SceneWork = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const a = startSceneJob(db, "u", msg("m3"), undefined, work);
    const b = startSceneJob(db, "u", msg("m3"), undefined, work);
    expect(b).toBe(a);
    release();
    await tick();
  });

  it("任务串行：前一个结束前，后一个不开始", async () => {
    const started: string[] = [];
    let release1: () => void = () => {};
    const work1: SceneWork = async () => {
      started.push("m4");
      await new Promise<void>((r) => {
        release1 = r;
      });
    };
    const work2: SceneWork = async () => {
      started.push("m5");
    };
    startSceneJob(db, "u", msg("m4"), undefined, work1);
    startSceneJob(db, "u", msg("m5"), undefined, work2);
    await tick();
    expect(started).toEqual(["m4"]);
    release1();
    await tick();
    await tick();
    expect(started).toEqual(["m4", "m5"]);
  });
});

describe("配图任务取消（停止按钮）", () => {
  it("取消运行中的任务：abort 传导、任务移出表、不算错误", async () => {
    let aborted = false;
    const work: SceneWork = (_db, _u, _m, _p, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    startSceneJob(db, "u", msg("c1"), undefined, work);
    await tick();
    expect(isSceneGenerating("c1")).toBe(true);

    expect(cancelSceneJob("c1")).toBe(true);
    await tick();
    expect(aborted).toBe(true);
    expect(getSceneJob("c1")).toBeUndefined();
    expect(isSceneGenerating("c1")).toBe(false);
  });

  it("取消排队中的任务：轮到它时直接跳过、不启动", async () => {
    const started: string[] = [];
    let release1: () => void = () => {};
    const work1: SceneWork = async () => {
      started.push("c2");
      await new Promise<void>((r) => {
        release1 = r;
      });
    };
    const work2: SceneWork = async () => {
      started.push("c3");
    };
    startSceneJob(db, "u", msg("c2"), undefined, work1);
    startSceneJob(db, "u", msg("c3"), undefined, work2);
    await tick();
    expect(started).toEqual(["c2"]);

    expect(cancelSceneJob("c3")).toBe(true);
    release1();
    await tick();
    await tick();
    // c3 被取消后不应再执行
    expect(started).toEqual(["c2"]);
    expect(getSceneJob("c3")).toBeUndefined();
  });

  it("取消不存在的任务返回 false", () => {
    expect(cancelSceneJob("nope")).toBe(false);
  });

  it("内存丢失后从数据库镜像恢复在途任务（刷新 / 模块重编译）", async () => {
    let release: () => void = () => {};
    const work: SceneWork = () =>
      new Promise<void>((r) => {
        release = r;
      });
    startSceneJob(db, "u", msg("rec1"), undefined, work);
    await tick();
    __resetSceneJobs(); // 清空内存快路径
    const j = getSceneJob("rec1", db);
    expect(j && (j.status === "queued" || j.status === "running")).toBeTruthy();
    release();
  });
});
