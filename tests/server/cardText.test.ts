import { describe, it, expect } from "vitest";
import { cleanCardText, cardIntroText } from "../../src/lib/labels";

describe("cleanCardText（导入卡文本清洗）", () => {
  it("掐掉 [Personality=...] / <START> / {{user}} 这类模板污染", () => {
    const raw =
      "[Seraphina's Personality= \"caring\", \"protective\"] [Seraphina's body= \"pink hair\"] <START> {{user}}: \"Describe your traits?\" {{char}}: *smiles*";
    const out = cleanCardText(raw, 120);
    expect(out).not.toContain("[");
    expect(out).not.toContain("Personality");
    expect(out).not.toContain("START");
    expect(out).not.toContain("{{");
    expect(out).not.toContain("*");
  });

  it("保留正常描述，去掉 markdown 与 RP 星号，压平空白", () => {
    const out = cleanCardText("## 薇拉\n**爽朗**、护短，*走过柜台*。", 120);
    expect(out).toBe("薇拉 爽朗、护短，走过柜台。");
  });

  it("超长截断并加省略号", () => {
    const out = cleanCardText("字".repeat(300), 20);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith("…")).toBe(true);
  });

  it("空输入返回空串；纯模板串返回空", () => {
    expect(cleanCardText("")).toBe("");
    expect(cleanCardText("[A=1][B=2]").trim()).toBe("");
    // 模板后面还有正文时，保留正文
    expect(cleanCardText("[A=1] 正常描述").trim()).toBe("正常描述");
  });
});

describe("cardIntroText（生态卡简介兜底）", () => {
  it("Seraphina 式全模板 description：改用字段块里的性格词", () => {
    const persona = {
      description:
        '[Seraphina\'s Personality= "caring", "protective", "healing", "warm"]\n[Seraphina\'s body= "pink hair"]\n<START>\n{{user}}: "hi"\n{{char}}: *smiles*',
    };
    const intro = cardIntroText(persona, 120);
    expect(intro).toContain("caring");
    expect(intro).not.toContain("Seraphina's");
    expect(intro).not.toContain("[");
  });

  it("有自我推介时优先用推介", () => {
    expect(cardIntroText({ self_intro: "哟，新面孔。", description: "别的" })).toBe("哟，新面孔。");
  });

  it("有可读 description 时用它", () => {
    expect(cardIntroText({ description: "一个守林人，温和而警觉。" })).toContain("守林人");
  });

  it("全空时用开场白首句兜底，仍不显示引号片段", () => {
    const intro = cardIntroText({ first_mes: "*她抬起头，琥珀色的眼睛看向你。*「你醒了。」" });
    expect(intro).toContain("你醒了");
  });
});
