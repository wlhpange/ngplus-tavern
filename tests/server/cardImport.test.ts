import { describe, it, expect } from "vitest";

import { toImportedCard } from "../../src/server/cardImport";

const CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "Elena",
    description: "A wandering scholar from the north, carrying a satchel of old maps.",
    personality: "Calm, curious, quietly stubborn.",
    scenario: "A rainy inn at the edge of the northern road.",
    first_mes: "You look wet. Sit by the fire.",
    tags: ["scholar", "traveler"],
    character_book: {
      name: "Northern Lore",
      entries: [
        {
          keys: ["north"],
          content: "The north is cold and full of old roads.",
          enabled: true,
          insertion_order: 100,
          constant: false,
        },
      ],
    },
  },
};

describe("角色卡导入（V2 + 内嵌世界书）", () => {
  it("解析卡名、版本与 character_book", () => {
    const card = toImportedCard(CARD);
    expect(card.name).toBe("Elena");
    expect(card.spec).toBe("v2");
    const book = card.characterBook as { entries?: unknown[] };
    expect(book.entries).toHaveLength(1);
  });
});
