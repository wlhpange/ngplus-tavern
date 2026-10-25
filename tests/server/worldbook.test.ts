import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateWorldBook,
  activatedWorldBookText,
  convertCharacterBook,
  matchKeys,
  parseDecorators,
  parseLorebook,
  type WorldBookEntry,
} from "../../src/server/worldbook";

function entry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    scope: 0,
    keys: [],
    secondaryKeys: [],
    content: "base",
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
    ...overrides,
  };
}

const msg = (content: string) => [{ role: "user", content }];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("世界书引擎：关键词与装饰器", () => {
  it("默认忽略大小写，可切换大小写敏感与正则", () => {
    expect(matchKeys("The Clocktower", ["clocktower"])).toBe(true);
    expect(matchKeys("The Clocktower", ["clocktower"], { caseSensitive: true })).toBe(false);
    expect(matchKeys("The Clocktower", ["clock", "tower"])).toBe(true);
    expect(matchKeys("bell-42", ["bell-\\d+"], { useRegex: true })).toBe(true);
    expect(matchKeys("bell", [])).toBe(false);
  });

  it("解析已知装饰器并从正文剥离", () => {
    const parsed = parseDecorators("@@depth 2\n@@position after\n@@role user\n灯亮着。");
    expect(parsed.decorators).toEqual({ depth: "2", position: "after", role: "user" });
    expect(parsed.content).toBe("灯亮着。");
  });

  it("未知装饰器走 @@@ fallback", () => {
    const parsed = parseDecorators("@@unknown 1\n@@@depth 3\n正文");
    expect(parsed.decorators).toEqual({ depth: "3" });
    expect(parsed.content).toBe("正文");
  });
});

describe("世界书引擎：激活规则", () => {
  it("常驻条目不看关键词，始终激活", () => {
    const a = activateWorldBook([entry({ id: "c", constant: true, content: "协会通史" })], {
      messages: msg("今天天气不错"),
    });
    expect(a.activated).toEqual(["c"]);
    expect(a.before).toBe("协会通史");
    expect(activatedWorldBookText(a)).toContain("协会通史");
  });

  it("关键词只扫描最近 scanDepth 条消息", () => {
    const e = entry({ id: "k", keys: ["bell"], content: "钟楼", scanDepth: 1 });
    const hit = activateWorldBook([e], { messages: msg("bell rings") });
    expect(hit.activated).toEqual(["k"]);
    const miss = activateWorldBook([e], {
      messages: [
        { role: "user", content: "bell rings" },
        { role: "user", content: "unrelated" },
      ],
    });
    expect(miss.activated).toEqual([]);
  });

  it("selective 需要次级关键词同时命中", () => {
    const e = entry({
      id: "s",
      keys: ["bell"],
      selective: true,
      secondaryKeys: ["night"],
      content: "夜里的钟",
    });
    expect(activateWorldBook([e], { messages: msg("bell rings") }).activated).toEqual([]);
    expect(activateWorldBook([e], { messages: msg("bell rings at night") }).activated).toEqual(["s"]);
  });

  it("停用条目永不激活", () => {
    const e = entry({ id: "off", constant: true, enabled: false, content: "旧设定" });
    expect(activateWorldBook([e], { messages: msg("任何") }).activated).toEqual([]);
  });

  it("按 before / after / at_depth 分组，深度与角色保留", () => {
    const a = activateWorldBook(
      [
        entry({ id: "b", constant: true, content: "前文", position: "before", insertionOrder: 10 }),
        entry({ id: "a", constant: true, content: "后文", position: "after", insertionOrder: 20 }),
        entry({
          id: "d",
          constant: true,
          content: "深层提示",
          position: "at_depth",
          depth: 2,
          role: "user",
          insertionOrder: 30,
        }),
      ],
      { messages: msg("x") },
    );
    expect(a.before).toBe("前文");
    expect(a.after).toBe("后文");
    expect(a.depth).toEqual([{ depth: 2, role: "user", content: "深层提示" }]);
  });

  it("token 预算溢出时按顺序跳过，ignore_budget 可越过预算", () => {
    const entries = [
      entry({ id: "a", constant: true, content: "AAAA", insertionOrder: 10 }), // 2 tokens
      entry({ id: "b", constant: true, content: "BBBBBBBB", insertionOrder: 20 }), // 4 tokens
    ];
    const capped = activateWorldBook(entries, { messages: msg("x"), budgetTokens: 5 });
    expect(capped.activated).toEqual(["a"]);

    const ignored = activateWorldBook(
      [entries[0], { ...entries[1], extensions: { ignore_budget: true } }],
      { messages: msg("x"), budgetTokens: 5 },
    );
    expect(ignored.activated).toEqual(["a", "b"]);
  });

  it("递归扫描能带出次级条目，可整体关闭或单条阻止", () => {
    const first = entry({ id: "first", keys: ["bell"], content: "提到 candle", insertionOrder: 20 });
    const second = entry({ id: "second", keys: ["candle"], content: "蜡烛的来历", insertionOrder: 10 });

    expect(activateWorldBook([first, second], { messages: msg("bell") }).activated.sort()).toEqual([
      "first",
      "second",
    ]);
    expect(
      activateWorldBook([first, second], { messages: msg("bell"), recursive: false }).activated,
    ).toEqual(["first"]);

    const blocked = { ...first, extensions: { prevent_recursion: true } };
    expect(activateWorldBook([blocked, second], { messages: msg("bell") }).activated).toEqual(["first"]);
  });

  it("概率扩展：小于 1 时按随机数决定", () => {
    const e = entry({ id: "p", constant: true, content: "偶发", extensions: { probability: 0.2 } });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(activateWorldBook([e], { messages: msg("x") }).activated).toEqual([]);
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    expect(activateWorldBook([e], { messages: msg("x") }).activated).toEqual(["p"]);
  });
});

describe("世界书导入解析", () => {
  it("角色卡内嵌 character_book 映射位置 / 深度 / 角色 / 扩展", () => {
    const out = convertCharacterBook({
      entries: [
        {
          keys: ["钟楼"],
          secondary_keys: ["夜"],
          content: "钟楼在夜里响。",
          enabled: true,
          constant: true,
          selective: true,
          insertion_order: 7,
          extensions: { position: "after_char", depth: 2, role: 1, foo: "bar" },
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      keys: ["钟楼"],
      secondaryKeys: ["夜"],
      constant: true,
      selective: true,
      insertionOrder: 7,
      position: "after",
      depth: 2,
      role: "user",
      extensions: { foo: "bar", cc_index: 0 },
    });
  });

  it("支持 lorebook_v3 包装与裸数组", () => {
    const wrapped = parseLorebook({
      spec: "lorebook_v3",
      data: { entries: [{ keys: ["a"], content: "A" }] },
    });
    expect(wrapped[0].content).toBe("A");

    const bare = parseLorebook([{ keys: ["b"], content: "B", position: 4 }]);
    expect(bare[0].position).toBe("at_depth");
  });
});
