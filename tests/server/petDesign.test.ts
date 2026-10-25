import { describe, it, expect } from "vitest";

import {
  defaultSprite,
  keywordSprite,
  sanitizeSprite,
  spriteTextFromCard,
} from "../../src/server/petDesign";

const card = (p: Record<string, unknown>) => JSON.stringify(p);

describe("形象映射 · 纯规则", () => {
  it("英文卡：银发红瞳黑风衣皮靴", () => {
    const d = keywordSprite(
      "Elena is a young woman with silver hair and red eyes, wearing a black coat and leather boots.",
    );
    expect(d.bodyType).toBe("female");
    expect(d.colors.hair).toBe("white");
    expect(d.colors.eye).toBe("red");
    expect(d.colors.cloth).toBe("black");
    expect(d.items.top).toBe("torso_clothes_longsleeve2");
    expect(d.items.shoes).toBe("feet_boots_basic");
  });

  it("中文卡：及腰银白长发 / 红瞳 / 黑风衣", () => {
    const d = keywordSprite("她有一头及腰的银白长发，红色瞳孔，穿着黑色风衣和长裤。");
    expect(d.bodyType).toBe("female");
    expect(d.colors.hair).toBe("white");
    expect(d.items.hair).toBe("hair_long_straight");
    expect(d.colors.eye).toBe("red");
    expect(d.colors.cloth).toBe("black");
    expect(d.items.bottom).toBe("legs_pants2");
  });

  it("英文男卡：短发黑发蓝眼板甲", () => {
    const d = keywordSprite("He is a tall man with short black hair and blue eyes, wearing plate armor.");
    expect(d.bodyType).toBe("male");
    expect(d.items.head).toBe("heads_human_male");
    expect(d.colors.hair).toBe("black");
    expect(d.items.hair).toBe("hair_page");
    expect(d.colors.eye).toBe("blue");
    expect(d.items.top).toBe("torso_armour_plate");
  });

  it("别把 the 里的 he 当成男性", () => {
    const d = keywordSprite("The tavern is warm. She sits by the fire with her dog.");
    expect(d.bodyType).toBe("female");
  });

  it("别把「其他」里的「他」当成男性", () => {
    const d = keywordSprite("她看着其他冒险者，摇摇头。");
    expect(d.bodyType).toBe("female");
  });

  it("完全没写长相时保持默认，不产生随机差异", () => {
    const d = keywordSprite("名字：某人");
    const base = defaultSprite();
    expect(d.bodyType).toBe(base.bodyType);
    expect(d.items).toEqual(base.items);
    expect(d.colors).toEqual(base.colors);
  });
});

describe("卡文字抽取", () => {
  it("把开场白 / 标签 / 备注也带进映射文本", () => {
    const text = spriteTextFromCard(
      "Elena",
      card({
        description: "A wandering scholar.",
        personality: "Calm, curious",
        first_mes: "You look wet. Sit by the fire.",
        tags: ["scholar", "traveler"],
        creator_notes: "Written for a rainy campaign.",
      }),
    );
    expect(text).toContain("名字：Elena");
    expect(text).toContain("描述：A wandering scholar.");
    expect(text).toContain("性格：Calm, curious");
    expect(text).toContain("开场白：You look wet.");
    expect(text).toContain("标签：scholar、traveler");
    expect(text).toContain("备注：Written for a rainy campaign.");
  });

  it("长相只写在开场白里也能被抓到", () => {
    const text = spriteTextFromCard(
      "Mira",
      card({ description: "", first_mes: "The woman with green eyes lowers her hood." }),
    );
    const d = keywordSprite(text);
    expect(d.colors.eye).toBe("green");
  });

  it("坏 JSON 不炸，只留名字", () => {
    expect(spriteTextFromCard("X", "{not json")).toBe("名字：X\n");
  });
});

describe("sanitize", () => {
  it("剔除不存在的部件与非法颜色", () => {
    const d = sanitizeSprite({
      bodyType: "male",
      items: { hair: "hair_does_not_exist", top: "torso_clothes_vest" },
      colors: { hair: "neon", cloth: "black" },
    });
    expect(d.bodyType).toBe("male");
    expect(d.items.hair).toBeUndefined();
    expect(d.items.top).toBe("torso_clothes_vest");
    expect(d.colors.hair).toBeUndefined();
    expect(d.colors.cloth).toBe("black");
    expect(d.items.head).toBe("heads_human_male");
  });

  it("容忍 LLM 写短名 / 英文颜色名", () => {
    const d = sanitizeSprite({
      bodyType: "male",
      items: { top: "longsleeve2", hair: "ponytail" },
      colors: { hair: "silver", cloth: "grey" },
    });
    expect(d.items.top).toBe("torso_clothes_longsleeve2");
    expect(d.items.hair).toBe("hair_ponytail");
    expect(d.colors.hair).toBe("white");
    expect(d.colors.cloth).toBe("gray");
  });
});
