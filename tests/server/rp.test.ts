import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "../../src/server/db";
import { createTestDb } from "../llm/helpers";
import { getRpSettings, setRpEnabled } from "../../src/server/rp";

let db: Db;

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("P4 R18 内容开关", () => {
  it("默认关闭", () => {
    expect(getRpSettings(db).enabled).toBe(false);
  });

  it("开启/关闭可持久化，幂等写入同一 key", () => {
    expect(setRpEnabled(db, true).enabled).toBe(true);
    expect(getRpSettings(db).enabled).toBe(true);
    expect(setRpEnabled(db, false).enabled).toBe(false);
    expect(getRpSettings(db).enabled).toBe(false);
    expect(setRpEnabled(db, true).enabled).toBe(true);
    expect(getRpSettings(db).enabled).toBe(true);
  });
});
