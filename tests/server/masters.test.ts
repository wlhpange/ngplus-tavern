import { describe, it, expect } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDb } from "../llm/helpers";
import {
  listSelectableMasters,
  getSaveState,
  switchMaster,
  createCustomMaster,
  normalizeRelationshipStages,
  archiveMaster,
  activeTenureStartedAt,
  addAffinityPoints,
  getAffinity,
  setChatMaster,
} from "../../src/server/masters";
import { ensureActiveSession, listSessions } from "../../src/server/chatSessions";
import { addMemory, listMemories } from "../../src/server/memory";
import {
  GALO_MASTER_ID,
  VILA_MASTER_ID,
} from "../../src/server/db/seed";
import {
  masterHistory,
  masters,
  memory,
  saves,
  chatLog,
} from "../../src/server/db/schema";
import { replaceBookEntries, listBookEntries, createBook, assignBook } from "../../src/server/worldbook";

describe("官方人格阵容（master-persona-design.md §8）", () => {
  it("四位官方会长入库", () => {
    const { db } = createTestDb();
    const list = listSelectableMasters(db, "local_user");
    expect(list).toHaveLength(4);
    expect(list.map((m) => m.name).sort()).toEqual(
      ["薇拉", "加洛", "莱恩", "墨"].sort(),
    );
    // 人格卡结构完整：mystery_hooks 2–3 个、sample_dialogues ≥3、三阶段
    for (const m of list) {
      expect(m.persona.mystery_hooks?.length).toBeGreaterThanOrEqual(2);
      expect(m.persona.mystery_hooks?.length).toBeLessThanOrEqual(3);
      expect(m.persona.sample_dialogues?.length).toBeGreaterThanOrEqual(3);
      expect(m.persona.relationship_stages?.map((s) => s.stage)).toEqual([
        1, 2, 3, 4,
      ]);
    }
  });
});

describe("会长热切换（交接仪式，§7）", () => {
  it("老会长任期写入 history（ended_at），新会长开启任期，亲密度重置，记忆保留", async () => {
    const { db, userId } = createTestDb();
    // 存档有记忆 + 亲密度已推进到 2
    db.insert(memory)
      .values({
        id: randomUUID(),
        userId,
        category: "goal",
        content: "今年背完 3000 单词",
        createdAt: Date.now(),
      })
      .run();
    // P11：给薇拉攒一点好感（按会长各存）
    addAffinityPoints(db, userId, VILA_MASTER_ID, 20);

    const result = await switchMaster(db, userId, GALO_MASTER_ID);

    expect(result.changed).toBe(true);
    expect(result.previousMasterId).toBe(VILA_MASTER_ID);
    expect(result.activeMasterId).toBe(GALO_MASTER_ID);

    const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
    expect(save.activeMasterId).toBe(GALO_MASTER_ID);
    // 换人不再清零：薇拉的好感留着，新会长从初识开始
    expect(getAffinity(db, userId, VILA_MASTER_ID).points).toBe(20);
    expect(getAffinity(db, userId, GALO_MASTER_ID).points).toBe(0);

    // 薇拉任期已结束
    const vilaTenure = db
      .select()
      .from(masterHistory)
      .where(eq(masterHistory.masterId, VILA_MASTER_ID))
      .get()!;
    expect(vilaTenure.endedAt).not.toBeNull();

    // 加洛任期开启、未结束
    const galoTenure = db
      .select()
      .from(masterHistory)
      .where(
        and(
          eq(masterHistory.masterId, GALO_MASTER_ID),
          isNull(masterHistory.endedAt),
        ),
      )
      .get();
    expect(galoTenure).toBeDefined();

    // 记忆保留（档案存在协会卷宗室，不随会长走）
    const mems = db.select().from(memory).where(eq(memory.userId, userId)).all();
    expect(mems).toHaveLength(1);
    expect(mems[0].content).toBe("今年背完 3000 单词");

    // 「初识+」推导：stage 1 + 存在已结束任期
    const state = getSaveState(db, userId)!;
    expect(state.intimacyStage).toBe(1);
    expect(state.intimacyLabel).toBe("初识+");
  });

  it("重复激活同一会长是 no-op，不产生新任期", async () => {
    const { db, userId } = createTestDb();
    const before = db.select().from(masterHistory).all().length;
    const result = await switchMaster(db, userId, VILA_MASTER_ID);
    expect(result.changed).toBe(false);
    expect(db.select().from(masterHistory).all().length).toBe(before);
  });

  it("激活不存在的会长报错", async () => {
    const { db, userId } = createTestDb();
    await expect(switchMaster(db, userId, "master_ghost")).rejects.toThrow(
      "会长不存在",
    );
  });

  it("旧存档缺初始任期行时补录完整任期", async () => {
    const { db, userId } = createTestDb();
    // 模拟旧种子：删除薇拉的开放任期行
    db.delete(masterHistory)
      .where(
        and(
          eq(masterHistory.masterId, VILA_MASTER_ID),
          isNull(masterHistory.endedAt),
        ),
      )
      .run();
    await switchMaster(db, userId, GALO_MASTER_ID);
    const vilaTenure = db
      .select()
      .from(masterHistory)
      .where(eq(masterHistory.masterId, VILA_MASTER_ID))
      .get()!;
    expect(vilaTenure.endedAt).not.toBeNull();
    expect(getSaveState(db, userId)!.intimacyLabel).toBe("初识+");
  });

  it("初始状态无历史切换时亲密度标签为「初识」", () => {
    const { db, userId } = createTestDb();
    expect(getSaveState(db, userId)!.intimacyLabel).toBe("初识");
    // masters 表的官方人格与种子幂等（二次调用不重复）
    expect(db.select().from(masters).all().length).toBe(4);
  });
});


describe("V1.9 指名邀请 · 自定义会长可见性", () => {
  it("本人自定义的会长出现在可选列表，且带 isOfficial=false", () => {
    const { db } = createTestDb();
        const created = createCustomMaster(db, "local_user", {
      name: "老周",
      brief: "协会的老会计出身",
      persona: { self_intro: "账，从来不会错。", personality: ["精明", "沉静"] },
    });
    expect(created.name).toBe("老周");

    const list = listSelectableMasters(db, "local_user");
    expect(list).toHaveLength(5);
    const zhou = list.find((m) => m.name === "老周")!;
    expect(zhou.isOfficial).toBe(false);
    // 官方四位不变
    expect(list.filter((m) => m.isOfficial)).toHaveLength(4);
  });

  it("createCustomMaster：空名/超长名/过短描述被拒", () => {
    const { db } = createTestDb();
        expect(() =>
      createCustomMaster(db, "local_user", {
        name: "",
        brief: "一段足够长的描述文本",
        persona: {},
      }),
    ).toThrow(/名字/);
    expect(() =>
      createCustomMaster(db, "local_user", {
        name: "这个会长名字长得完全不像话啦",
        brief: "一段足够长的描述文本",
        persona: {},
      }),
    ).toThrow(/名字/);
    expect(() =>
      createCustomMaster(db, "local_user", {
        name: "老周",
        brief: "太短",
        persona: {},
      }),
    ).toThrow(/描述/);
  });

  it("关系阶段缺省：漏给时补默认四阶段（初识/熟络/挚友/恋人）", () => {
    const { db } = createTestDb();
        const created = createCustomMaster(db, "local_user", {
      name: "无名氏",
      brief: "一段足够长的描述文本超过五字",
      persona: { personality: ["神秘"] },
    });
    const row = db
      .select()
      .from(masters)
      .where(eq(masters.id, created.id))
      .get();
    expect(row).toBeDefined();
    const persona = JSON.parse(row!.personaJson);
    expect(persona.relationship_stages).toHaveLength(4);
    expect(persona.relationship_stages[0].label).toBe("初识");
    expect(persona.relationship_stages[2].label).toBe("挚友");
    expect(persona.relationship_stages[3].label).toBe("恋人");
  });

  it("V2.0 锻造关系阶段：给到的档位用锻造内容，缺的档位用默认补齐", () => {
    const { db } = createTestDb();
    const created = createCustomMaster(db, "local_user", {
      name: "阿岚",
      brief: "一段足够长的描述文本超过五字",
      persona: {
        personality: ["机灵"],
        relationship_stages: [
          { stage: 2, label: "搭档", address: "老搭档", tone_note: "损友式打趣" },
        ],
      },
    });
    const row = db.select().from(masters).where(eq(masters.id, created.id)).get()!;
    const stages = JSON.parse(row.personaJson).relationship_stages as {
      stage: number;
      label: string;
      address: string;
      tone_note: string;
    }[];
    expect(stages).toHaveLength(4);
    // stage 2 用锻造内容
    expect(stages[1]).toEqual({
      stage: 2,
      label: "搭档",
      address: "老搭档",
      tone_note: "损友式打趣",
    });
    // 缺的档位用默认补齐
    expect(stages[0].label).toBe("初识");
    expect(stages[2].label).toBe("挚友");
    expect(stages[3].label).toBe("恋人");
  });

  it("normalizeRelationshipStages：空值/乱序/空字符串都收敛为四档完整结构", () => {
    // 完全缺失 → 默认四阶段
    expect(normalizeRelationshipStages(undefined).map((s) => s.label)).toEqual([
      "初识",
      "熟络",
      "挚友",
      "恋人",
    ]);
    // 乱序 + 越界 stage + 空 label → 按 stage 归位，空字段回退默认
    const normalized = normalizeRelationshipStages([
      { stage: 3, label: "", address: "自家人", tone_note: "护短" },
      { stage: 9, label: "不该存在", address: "x", tone_note: "x" },
      { stage: 1, label: "点头之交", address: "生人", tone_note: "客气" },
    ]);
    expect(normalized.map((s) => s.stage)).toEqual([1, 2, 3, 4]);
    expect(normalized[0].label).toBe("点头之交");
    expect(normalized[1].label).toBe("熟络"); // stage 2 缺失 → 默认
    expect(normalized[2].label).toBe("挚友"); // 空 label → 默认
    expect(normalized[3].label).toBe("恋人"); // stage 4 缺失 → 默认
  });
});

describe("P1 会长归档（软删除）", () => {
  const brief = "一段足够长的描述文本超过五字";

  it("官方会长不可删除", () => {
    const { db, userId } = createTestDb();
    expect(() => archiveMaster(db, userId, VILA_MASTER_ID)).toThrow(/官方/);
  });

  it("当前在任的会长不可删除", () => {
    const { db, userId } = createTestDb();
    const created = createCustomMaster(db, userId, {
      name: "老周",
      brief,
      persona: {},
    });
    // 切到老周使其在任
    db.update(saves).set({ activeMasterId: created.id }).where(eq(saves.userId, userId)).run();
    expect(() => archiveMaster(db, userId, created.id)).toThrow(/在任/);
  });

  it("删除后从候选列表消失，但历史任期里的名字仍能解析", async () => {
    const { db, userId } = createTestDb();
    const created = createCustomMaster(db, userId, {
      name: "老周",
      brief,
      persona: {},
    });
    // 让老周上过任再卸任（产生历史）
    await switchMaster(db, userId, created.id);
    await switchMaster(db, userId, VILA_MASTER_ID);

    archiveMaster(db, userId, created.id);

    const list = listSelectableMasters(db, userId);
    expect(list.some((m) => m.id === created.id)).toBe(false);
    // 行仍在（软删除），任期记录仍在
    const row = db.select().from(masters).where(eq(masters.id, created.id)).get();
    expect(row?.archivedAt).not.toBeNull();
    const tenure = db
      .select()
      .from(masterHistory)
      .where(eq(masterHistory.masterId, created.id))
      .get();
    expect(tenure).toBeDefined();
  });

  it("activeTenureStartedAt：当前任期起点为正数（换人后更新）", async () => {
    const { db, userId } = createTestDb();
    const t0 = activeTenureStartedAt(db, userId);
    expect(t0).toBeGreaterThan(0);
    await switchMaster(db, userId, GALO_MASTER_ID);
    const t1 = activeTenureStartedAt(db, userId);
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it("归档会长时连带清掉它的专属书册，但不影响其他会长的书", () => {
    const { db, userId } = createTestDb();
    const created = createCustomMaster(db, userId, {
      name: "老周",
      brief,
      persona: {},
    });
    const other = createBook(db, userId, "别人的世界书");
    replaceBookEntries(db, userId, other, [{ keys: [], content: "别的世界书" }]);
    const book = createBook(db, userId, "老周的世界书");
    replaceBookEntries(db, userId, book, [{ keys: [], content: "老周的世界书条目" }]);
    assignBook(db, userId, created.id, book);

    expect(listBookEntries(db, userId, book)).toHaveLength(1);

    archiveMaster(db, userId, created.id);

    // 只属于老周的书册连同条目被删
    expect(listBookEntries(db, userId, book)).toHaveLength(0);
    // 别的书不受影响
    expect(listBookEntries(db, userId, other)).toHaveLength(1);
  });

  it("P12 归档会长时删除其酒馆聊天记录与对话记忆，并清掉聊天会长指向", () => {
    const { db, userId } = createTestDb();
    const created = createCustomMaster(db, userId, {
      name: "老周",
      brief,
      persona: {},
    });
    // 指为聊天会长（任务会长仍是薇拉，不触发「在任不可删」）
    setChatMaster(db, userId, created.id);
    const sid = ensureActiveSession(db, userId, created.id);
    db.insert(chatLog)
      .values({
        id: "c1",
        userId,
        role: "master",
        content: "老周的酒馆开场白",
        masterId: created.id,
        mode: "chat",
        sessionId: sid,
        createdAt: Date.now(),
      })
      .run();
    addMemory(db, userId, created.id, "story", "对话里的秘密", sid);
    expect(listSessions(db, userId, created.id)).toHaveLength(1);
    expect(listMemories(db, userId, null, sid)).toHaveLength(1);

    archiveMaster(db, userId, created.id);

    // 会话、消息、对话记忆全部清掉
    expect(listSessions(db, userId, created.id)).toHaveLength(0);
    expect(db.select().from(chatLog).where(eq(chatLog.sessionId, sid)).all()).toHaveLength(0);
    expect(listMemories(db, userId, null, sid)).toHaveLength(0);
    // 聊天会长指向被清除
    const save = db.select().from(saves).where(eq(saves.userId, userId)).get()!;
    expect(save.chatMasterId).toBeNull();
  });
});

describe("P11 亲密度（每会长一份，只由送礼推进）", () => {
  it("同一会长累积、跨阈值升阶段；不同会长互不影响", () => {
    const { db, userId } = createTestDb();
    const r1 = addAffinityPoints(db, userId, VILA_MASTER_ID, 7);
    expect(r1.points).toBe(7);
    expect(r1.toStage).toBe(1);
    const r2 = addAffinityPoints(db, userId, VILA_MASTER_ID, 1);
    expect(r2.stageChanged).toBe(true);
    expect(r2.fromStage).toBe(1);
    expect(r2.toStage).toBe(2);
    expect(getAffinity(db, userId, VILA_MASTER_ID).points).toBe(8);
    // 另一位会长不受影响
    expect(getAffinity(db, userId, GALO_MASTER_ID).points).toBe(0);
  });
});
