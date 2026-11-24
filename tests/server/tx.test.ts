import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/server/db";
import { chatLog } from "../../src/server/db/schema";
import { tx } from "../../src/server/db/tx";
import { createTestDb } from "../llm/helpers";

let db: Db;
let userId: string;

beforeEach(() => {
  ({ db, userId } = createTestDb());
});

function insertMessage(id: string) {
  db.insert(chatLog)
    .values({ id, userId, role: "user", content: id, createdAt: 1 })
    .run();
}

describe("tx（同步事务包装）", () => {
  it("回调抛错时整体回滚", () => {
    expect(() =>
      tx(db, () => {
        insertMessage("a");
        insertMessage("b");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.select().from(chatLog).all()).toHaveLength(0);
  });

  it("正常返回时提交并透传返回值", () => {
    const value = tx(db, () => {
      insertMessage("c");
      return 42;
    });
    expect(value).toBe(42);
    expect(db.select().from(chatLog).all()).toHaveLength(1);
  });
});
