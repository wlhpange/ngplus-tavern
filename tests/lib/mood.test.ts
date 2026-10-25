import { describe, it, expect } from "vitest";
import { detectFace } from "../../src/weblib/mood";

describe("情绪 → 表情识别", () => {
  it("命中对应情绪", () => {
    expect(detectFace("他笑了笑，嘴角微微上扬。")).toBe("face_happy");
    expect(detectFace("她愤怒地瞪着他，声音发冷。")).toBe("face_angry");
    expect(detectFace("眼泪止不住地流下来。")).toBe("face_sad");
    expect(detectFace("她脸红了，别过头去。")).toBe("face_blush");
    expect(detectFace("他震惊地看着眼前的一切。")).toBe("face_shock");
  });

  it("英文同样能识别", () => {
    expect(detectFace("She laughed, clearly happy about it.")).toBe("face_happy");
    expect(detectFace("He was furious and shouted.")).toBe("face_angry");
  });

  it("无命中 → neutral；同分按优先级（惊 > 喜）", () => {
    expect(detectFace("今天天气不错，我们出发了。")).toBe("face_neutral");
    expect(detectFace("")).toBe("face_neutral");
    // 惊讶与笑各一次，惊讶优先
    expect(detectFace("他震惊地笑了。")).toBe("face_shock");
  });
});
