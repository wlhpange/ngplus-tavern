import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { createTestDb } from "../llm/helpers";
import {
  activateWorldBook,
  convertCharacterBook,
  parseDecorators,
  matchKeys,
  replaceBookEntries,
  appendBookEntries,
  upsertBookEntry,
  deleteBookEntry,
  listBookEntries,
  listWorldBookEntries,
  listWorldBooks,
  createBook,
  deleteBook,
  assignBook,
  unassignBook,
  listBooksForMaster,
  listMastersForBook,
  parseLorebook,
  purgeGlobalBooks,
  type WorldBookEntry,
} from "../../src/server/worldbook";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function entry(partial: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    scope: 0,
    keys: [],
    secondaryKeys: [],
    content: "",
    enabled: true,
    constant: false,
    selective: false,
    insertionOrder: 100,
    position: "before",
    depth: 4,
    role: "system",
    priority: null,
    caseSensitive: false,
    useRegex: false,
    scanDepth: null,
    extensions: {},
    ...partial,
  };
}

describe("P2 世界书 · 装饰器", () => {
  it("解析已知装饰器并从正文剥离；未知装饰器看 @@@ fallback", () => {
    const { decorators, content } = parseDecorators(
      "@@depth 7\n@@position after\n正文内容",
    );
    expect(decorators.depth).toBe("7");
    expect(decorators.position).toBe("after");
    expect(content).toBe("正文内容");

    const fb = parseDecorators("@@unknown_thing 1\n@@@activate\n正文");
    expect(fb.decorators.activate).toBe("");
    expect(fb.content).toBe("正文");
  });

  it("非装饰器正文原样返回", () => {
    const { decorators, content } = parseDecorators("这是一段普通正文");
    expect(decorators).toEqual({});
    expect(content).toBe("这是一段普通正文");
  });
});

describe("P2 世界书 · 激活引擎", () => {
  it("constant 常驻注入 before", () => {
    const r = activateWorldBook(
      [entry({ constant: true, content: "协会设在旧钟楼。", position: "before" })],
      { messages: [] },
    );
    expect(r.before).toBe("协会设在旧钟楼。");
    expect(r.after).toBe("");
  });

  it("关键词命中才激活；未命中不注入", () => {
    const e = entry({ keys: ["剑"], content: "薇拉的剑叫「归途」。" });
    const hit = activateWorldBook([e], { messages: [{ role: "user", content: "你的剑呢" }] });
    expect(hit.before).toContain("归途");
    const miss = activateWorldBook([e], { messages: [{ role: "user", content: "今天天气" }] });
    expect(miss.before).toBe("");
  });

  it("scan_depth 限制扫描范围（默认 2 条）", () => {
    const e = entry({ id: "e1", keys: ["旧事"], content: "老故事" });
    const msgs = [
      { role: "user", content: "旧事" }, // 第 3 条（超出默认深度 2）
      { role: "user", content: "甲" },
      { role: "user", content: "乙" },
    ];
    expect(activateWorldBook([e], { messages: msgs }).before).toBe(""); // 深度 2 看不到最早那条
    expect(
      activateWorldBook([entry({ ...e, scanDepth: 5 })], { messages: msgs }).before,
    ).toBe("老故事");
  });

  it("selective + secondary_keys 需要两把钥匙同时命中", () => {
    const e = entry({
      keys: ["薇拉"],
      secondaryKeys: ["往事"],
      selective: true,
      content: "秘密往事",
    });
    expect(
      activateWorldBook([e], { messages: [{ role: "user", content: "薇拉 往事" }] }).before,
    ).toBe("秘密往事");
    expect(
      activateWorldBook([e], { messages: [{ role: "user", content: "薇拉 你好" }] }).before,
    ).toBe("");
  });

  it("insertion_order 决定同位置的先后（低者在前），角色书优先于全局书", () => {
    const r = activateWorldBook(
      [
        entry({ id: "g", scope: 1, constant: true, content: "全局", insertionOrder: 1 }),
        entry({ id: "c2", scope: 0, constant: true, content: "角色后", insertionOrder: 50 }),
        entry({ id: "c1", scope: 0, constant: true, content: "角色前", insertionOrder: 10 }),
      ],
      { messages: [] },
    );
    expect(r.before.split("\n")).toEqual(["角色前", "角色后", "全局"]);
  });

  it("位置：before / after / at_depth 分别归位", () => {
    const r = activateWorldBook(
      [
        entry({ id: "b", constant: true, content: "前置" }),
        entry({ id: "a", constant: true, content: "后置", position: "after" }),
        entry({ id: "d", constant: true, content: "深度", position: "at_depth", depth: 3 }),
      ],
      { messages: [] },
    );
    expect(r.before).toBe("前置");
    expect(r.after).toBe("后置");
    expect(r.depth).toEqual([{ depth: 3, role: "system", content: "深度" }]);
  });

  it("token 预算：超预算的条目被丢弃", () => {
    const long = "x".repeat(200); // 估算 100 token
    const r = activateWorldBook(
      [
        entry({ id: "a", constant: true, content: long, insertionOrder: 1 }),
        entry({ id: "b", constant: true, content: long, insertionOrder: 2 }),
      ],
      { messages: [], budgetTokens: 120 },
    );
    expect(r.activated).toEqual(["a"]); // 第二条超预算被丢
  });

  it("递归扫描：已激活条目正文可触发另一条", () => {
    const r = activateWorldBook(
      [
        entry({ id: "a", keys: ["暗号"], content: "暗号指向「地下酒窖」。" }),
        entry({ id: "b", keys: ["地下酒窖"], content: "酒窖里藏着旧账本。" }),
      ],
      { messages: [{ role: "user", content: "暗号是什么" }] },
    );
    expect(r.activated).toContain("a");
    expect(r.activated).toContain("b");
    expect(r.before).toContain("旧账本");
  });

  it("装饰器 @@activate / @@dont_activate 强制开关", () => {
    const forced = activateWorldBook(
      [entry({ constant: false, keys: ["永远不会出现"], content: "@@activate\n强制注入" })],
      { messages: [] },
    );
    expect(forced.before).toBe("强制注入");

    const blocked = activateWorldBook(
      [entry({ constant: true, content: "@@dont_activate\n禁止注入" })],
      { messages: [] },
    );
    expect(blocked.before).toBe("");
  });

  it("禁用条目永不激活", () => {
    const r = activateWorldBook(
      [entry({ constant: true, enabled: false, content: "不该出现" })],
      { messages: [] },
    );
    expect(r.before).toBe("");
  });

  it("matchKeys：大小写与正则", () => {
    expect(matchKeys("Hello World", ["hello"])).toBe(true);
    expect(matchKeys("Hello World", ["hello"], { caseSensitive: true })).toBe(false);
    expect(matchKeys("abc123", ["^abc\\d+$"], { useRegex: true })).toBe(true);
  });
});

describe("P2 世界书 · character_book 转换", () => {
  it("映射 V2 字段与 extensions 里的进阶信息", () => {
    const inserts = convertCharacterBook({
      entries: [
        {
          keys: ["协会"],
          secondary_keys: ["钟楼"],
          content: "协会在旧钟楼。",
          enabled: true,
          constant: false,
          selective: true,
          insertion_order: 7,
          position: "before_char",
          extensions: { depth: 6, role: "system", use_regex: false },
        },
        {
          keys: ["x"],
          content: "后置条目",
          position: "after_char",
        },
      ],
    });
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatchObject({
      keys: ["协会"],
      secondaryKeys: ["钟楼"],
      selective: true,
      insertionOrder: 7,
      position: "before",
      depth: 6,
    });
    expect(inserts[1].position).toBe("after");
  });
});

describe("P6 世界书 · 书册与多对多分配", () => {
  it("replaceBookEntries 幂等；一本世界书可同时分给多位会长", () => {
    // 一本共享世界书：挂给薇拉 + 加洛
    const shared = createBook(db, userId, "协会通史");
    replaceBookEntries(db, userId, shared, [{ keys: ["历史"], content: "协会创立于那年冬天。" }]);
    replaceBookEntries(db, userId, shared, [{ keys: ["历史"], content: "协会创立于那年冬天。" }]); // 重复导入幂等
    assignBook(db, userId, "master_vila", shared);
    assignBook(db, userId, "master_galo", shared);

    // 两位会长的激活集合里都有这本
    for (const mid of ["master_vila", "master_galo"]) {
      const contents = listWorldBookEntries(db, userId, mid).map((e) => e.content);
      expect(contents).toContain("协会创立于那年冬天。");
    }
    // 没挂的会长看不到
    expect(listWorldBookEntries(db, userId, "master_lain")).toHaveLength(0);
    // 反向：这本书被谁在用
    expect(listMastersForBook(db, userId, shared).sort()).toEqual(["master_galo", "master_vila"]);
    // 正查：薇拉挂了哪些书
    expect(listBooksForMaster(db, userId, "master_vila").map((b) => b.id)).toEqual([shared]);
  });

  it("会长专属书册：取消分配后不再注入；别的会长不受影响", () => {
    const solo = createBook(db, userId, "薇拉的旧事");
    replaceBookEntries(db, userId, solo, [{ keys: [], content: "只有薇拉知道的事。" }]);
    assignBook(db, userId, "master_vila", solo);

    expect(listWorldBookEntries(db, userId, "master_vila").map((e) => e.content)).toContain(
      "只有薇拉知道的事。",
    );
    expect(listWorldBookEntries(db, userId, "master_galo").map((e) => e.content)).not.toContain(
      "只有薇拉知道的事。",
    );

    unassignBook(db, userId, "master_vila", solo);
    expect(listWorldBookEntries(db, userId, "master_vila").map((e) => e.content)).not.toContain(
      "只有薇拉知道的事。",
    );
    // 书册本身还在（只是没人挂了）
    expect(listWorldBooks(db, userId).some((b) => b.id === solo)).toBe(true);
  });

  it("删除书册：连带条目与分配", () => {
    const book = createBook(db, userId, "临时书");
    const entryId = upsertBookEntry(db, userId, book, { keys: [], content: "x" });
    assignBook(db, userId, "master_vila", book);

    expect(deleteBook(db, userId, book)).toBe(true);
    expect(listBookEntries(db, userId, book)).toHaveLength(0);
    expect(listMastersForBook(db, userId, book)).toHaveLength(0);
    expect(deleteBookEntry(db, userId, entryId)).toBe(false); // 已随书册删除

    // 不存在的书删不掉
    expect(deleteBook(db, userId, "no-such-book")).toBe(false);
  });

  it("purgeGlobalBooks：清掉 P6 遗留的全局书（幂等）", () => {
    const n = purgeGlobalBooks(db, userId);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(purgeGlobalBooks(db, userId)).toBe(0);
    // 业务书册不受影响
    const b = createBook(db, userId, "正常书");
    expect(listWorldBooks(db, userId).some((x) => x.id === b)).toBe(true);
  });

  it("listWorldBooks：含条目数", () => {
    const books1 = listWorldBooks(db, userId);
    expect(books1.every((b) => !("isGlobal" in b))).toBe(true);
    const b = createBook(db, userId, "统计用书");
    replaceBookEntries(db, userId, b, [
      { keys: [], content: "A" },
      { keys: [], content: "B" },
    ]);
    expect(listWorldBooks(db, userId).find((x) => x.id === b)?.entryCount).toBe(2);
  });

  it("upsertBookEntry / deleteBookEntry 生效", () => {
    const book = createBook(db, userId, "B");
    const id = upsertBookEntry(db, userId, book, { keys: ["钟楼"], content: "旧钟楼。" });
    expect(listBookEntries(db, userId, book)).toHaveLength(1);
    upsertBookEntry(db, userId, book, { id, keys: ["钟楼"], content: "改过的。" });
    expect(listBookEntries(db, userId, book)[0].content).toBe("改过的。");
    expect(deleteBookEntry(db, userId, id)).toBe(true);
    expect(listBookEntries(db, userId, book)).toHaveLength(0);
  });

  it("appendBookEntries 追加不清空", () => {
    const book = createBook(db, userId, "B");
    appendBookEntries(db, userId, book, [{ keys: [], content: "A" }]);
    appendBookEntries(db, userId, book, [{ keys: [], content: "B" }]);
    expect(listBookEntries(db, userId, book).map((e) => e.content).sort()).toEqual(["A", "B"]);
  });

  it("parseLorebook：lorebook_v3 / {entries} / 裸数组", () => {
    expect(
      parseLorebook({ spec: "lorebook_v3", data: { entries: [{ keys: ["x"], content: "c" }] } }),
    ).toHaveLength(1);
    expect(parseLorebook({ entries: [{ keys: ["y"], content: "d" }] })).toHaveLength(1);
    expect(parseLorebook([{ keys: ["z"], content: "e" }])).toHaveLength(1);
    expect(parseLorebook({})).toHaveLength(0);
  });
});
