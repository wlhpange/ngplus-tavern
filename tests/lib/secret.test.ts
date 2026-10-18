import { describe, it, expect } from "vitest";
import { registerSecretTap, SECRET_TAPS, SECRET_WINDOW_MS } from "../../src/lib/secret";

describe("设置页彩蛋：连点解锁", () => {
  it("连续 SECRET_TAPS 次（间隔内）达成解锁，并清空计数", () => {
    let taps: number[] = [];
    let unlocked = false;
    for (let i = 0; i < SECRET_TAPS; i++) {
      ({ taps, unlocked } = registerSecretTap(taps, 1000 + i * 200));
    }
    expect(unlocked).toBe(true);
    expect(taps).toEqual([]);
  });

  it("点数不足不解锁", () => {
    let taps: number[] = [];
    let unlocked = false;
    for (let i = 0; i < SECRET_TAPS - 1; i++) {
      ({ taps, unlocked } = registerSecretTap(taps, 1000 + i * 100));
    }
    expect(unlocked).toBe(false);
    expect(taps).toHaveLength(SECRET_TAPS - 1);
  });

  it("间隔超过窗口则旧点击过期、重新计数", () => {
    let taps: number[] = [];
    let unlocked = false;
    for (let i = 0; i < SECRET_TAPS - 1; i++) {
      ({ taps, unlocked } = registerSecretTap(taps, 1000 + i * 100));
    }
    const late = 1000 + (SECRET_TAPS - 1) * 100 + SECRET_WINDOW_MS + 1;
    ({ taps, unlocked } = registerSecretTap(taps, late));
    expect(unlocked).toBe(false);
    expect(taps).toHaveLength(1);
  });
});
