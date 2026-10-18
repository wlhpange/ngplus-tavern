import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/server/db";
import { quests } from "../../src/server/db/schema";
import { repeatQuest } from "../../src/server/quests";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function makeQuest(overrides: Partial<typeof quests.$inferInsert> = {}): string {
  const id = overrides.id ?? `q_${Math.random().toString(36).slice(2, 8)}`;
  db.insert(quests)
    .values({
      id,
      userId,
      title: "每天跑步 5 公里",
      description: "风雨无阻",
      type: "daily",
      category: "独自运动",
      primaryAttr: "vitality",
      primaryWeight: 0.8,
      secondaryAttr: "willpower",
      secondaryWeight: 0.2,
      attrReason: "跑量练体魄",
      difficulty: 3,
      status: "completed",
      streak: 0,
      completedAt: Date.now(),
      createdAt: Date.now(),
      ...overrides,
    })
    .run();
  return id;
}

describe("一键重挂（repeatQuest，V3：确认后直接进行中）", () => {
  it("完成委托 → 复制成新的 active 委托，参数照抄、日期与完成态清空", () => {
    const id = makeQuest({ checkin: 1, deadline: Date.now() + 86_400_000 });
    const r = repeatQuest(db, userId, id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quest.status).toBe("active");

    const copy = db.select().from(quests).where(eq(quests.id, r.quest.id)).get()!;
    expect(copy.status).toBe("active");
    expect(copy.title).toBe("每天跑步 5 公里");
    expect(copy.type).toBe("daily");
    expect(copy.category).toBe("独自运动");
    expect(copy.primaryAttr).toBe("vitality");
    expect(copy.primaryWeight).toBe(0.8);
    expect(copy.secondaryAttr).toBe("willpower");
    expect(copy.difficulty).toBe(3);
    expect(copy.checkin).toBe(1);
    expect(copy.deadline).toBeNull();
    expect(copy.completedAt).toBeNull();
    expect(copy.parentQuestId).toBeNull();
    // 原委托不受影响
    expect(db.select().from(quests).where(eq(quests.id, id)).get()!.status).toBe("completed");
  });

  it("逾期/放弃过的委托也能重挂", () => {
    const overdue = makeQuest({ status: "overdue", completedAt: null });
    const abandoned = makeQuest({ status: "abandoned", completedAt: null });
    expect(repeatQuest(db, userId, overdue).ok).toBe(true);
    expect(repeatQuest(db, userId, abandoned).ok).toBe(true);
  });

  it("进行中/待接受的委托拒绝重挂", () => {
    const active = makeQuest({ status: "active", completedAt: null });
    const proposed = makeQuest({ status: "proposed", completedAt: null });
    expect(repeatQuest(db, userId, active)).toMatchObject({ ok: false });
    expect(repeatQuest(db, userId, proposed)).toMatchObject({ ok: false });
  });

  it("主线与里程碑拒绝重挂", () => {
    const mainline = makeQuest({ type: "mainline", status: "completed" });
    const milestone = makeQuest({ type: "mainline_milestone", status: "completed" });
    expect(repeatQuest(db, userId, mainline)).toMatchObject({ ok: false });
    expect(repeatQuest(db, userId, milestone)).toMatchObject({ ok: false });
  });

  it("不存在的委托拒绝", () => {
    const r = repeatQuest(db, userId, "q_ghost");
    expect(r.ok).toBe(false);
  });
});
