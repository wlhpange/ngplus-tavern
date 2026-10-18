import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { createTestDb } from "../llm/helpers";
import {
  toImportedCard,
  parseCardBytes,
  extractPngTextChunks,
} from "../../src/server/cardImport";
import { createMasterFromCard, listSelectableMasters } from "../../src/server/masters";
import { listWorldBookEntries } from "../../src/server/worldbook";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

/** 造一个只含 tEXt chunks 的最小 PNG（解析器只关心签名 + chunk 结构） */
function makePng(chunks: { keyword: string; text: string }[]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts: Buffer[] = [sig];
  for (const c of chunks) {
    const data = Buffer.concat([
      Buffer.from(c.keyword, "latin1"),
      Buffer.from([0]),
      Buffer.from(c.text, "latin1"),
    ]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    parts.push(len, Buffer.from("tEXt", "latin1"), data, Buffer.alloc(4)); // CRC 占位
  }
  const iendLen = Buffer.alloc(4);
  parts.push(iendLen, Buffer.from("IEND", "latin1"), Buffer.alloc(4));
  return Buffer.concat(parts);
}

const V2_CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "夜巡者",
    description: "守夜的人。",
    personality: "冷静\n寡言\n警觉",
    scenario: "午夜的城墙上。",
    first_mes: "又一个睡不着的？",
    alternate_greetings: ["你也是来看星星的？"],
    mes_example: "{{user}}: 你是谁\n{{char}}: 不重要。",
    system_prompt: "保持沉默。",
    tags: ["守卫"],
    character_book: {
      entries: [
        { keys: ["城墙"], content: "城墙是旧时代留下的。", insertion_order: 3 },
      ],
    },
  },
};

describe("P5 角色卡导入 · 映射", () => {
  it("V2：字段从 data 取出，personality 字符串按行拆成数组", () => {
    const card = toImportedCard(V2_CARD);
    expect(card.spec).toBe("v2");
    expect(card.name).toBe("夜巡者");
    expect(card.persona.personality).toEqual(["冷静", "寡言", "警觉"]);
    expect(card.persona.first_mes).toBe("又一个睡不着的？");
    expect(card.persona.alternate_greetings).toEqual(["你也是来看星星的？"]);
    expect(card.persona.tags).toEqual(["守卫"]);
    expect(card.characterBook).not.toBeNull();
  });

  it("V1：平铺字段直接映射", () => {
    const card = toImportedCard({
      name: "老账房",
      description: "算盘不离手。",
      personality: "精明",
      first_mes: "账目我看过了。",
    });
    expect(card.spec).toBe("v1");
    expect(card.persona.personality).toEqual(["精明"]);
    expect(card.characterBook).toBeNull();
  });

  it("缺名字报错", () => {
    expect(() => toImportedCard({ spec: "chara_card_v2", data: {} })).toThrow(/名字/);
  });
});

describe("P5 角色卡导入 · PNG 解析", () => {
  it("从 chara chunk 读 base64 JSON；ccv3 优先", () => {
    const v2 = { name: "旧的", description: "chara" };
    const v3 = { name: "新的", description: "ccv3" };
    const png = makePng([
      { keyword: "chara", text: Buffer.from(JSON.stringify(v2), "utf8").toString("base64") },
      { keyword: "ccv3", text: Buffer.from(JSON.stringify(v3), "utf8").toString("base64") },
    ]);
    const chunks = extractPngTextChunks(png);
    expect(chunks).toHaveLength(2);
    const raw = parseCardBytes(png, "card.png") as { name: string };
    expect(raw.name).toBe("新的"); // ccv3 优先
  });

  it("JSON 文本直接解析", () => {
    const raw = parseCardBytes(Buffer.from(JSON.stringify(V2_CARD), "utf8"), "card.json");
    expect((raw as { spec: string }).spec).toBe("chara_card_v2");
  });

  it("非卡 PNG（无 tEXt 卡数据）报错", () => {
    const png = makePng([]);
    expect(() => parseCardBytes(png, "empty.png")).toThrow(/没有角色卡数据/);
  });
});

describe("P5 角色卡导入 · 落库", () => {
  it("createMasterFromCard：建会长 + 卡内世界书落成角色书", () => {
    const card = toImportedCard(V2_CARD);
    const created = createMasterFromCard(db, userId, card);
    expect(created.name).toBe("夜巡者");
    expect(created.worldBookEntries).toBe(1);

    const list = listSelectableMasters(db, userId);
    const imported = list.find((m) => m.id === created.id)!;
    expect(imported.isCustom).toBe(true);
    expect(imported.persona.first_mes).toBe("又一个睡不着的？");
    // 关系阶段补齐四档
    expect(imported.persona.relationship_stages?.map((s) => s.stage)).toEqual([1, 2, 3, 4]);

    const wb = listWorldBookEntries(db, userId, created.id);
    expect(wb).toHaveLength(1);
    expect(wb[0].content).toBe("城墙是旧时代留下的。");
    expect(wb[0].scope).toBe(0);
  });
});
