import type BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";
import { DDL } from "./ddl";
import { applyMigrations } from "./migrations";

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * better-sqlite3 走「运行时 require」而不是静态 import。
 * 原因：它经 bindings → file-uri-to-path 间接 require("fs"/"path")，
 * Next 的 instrumentation 构建链会对这条间接链报 module-not-found。
 * eval("require") 取包 → webpack 不参与解析，构建与运行都干净；
 * 类型仍由顶部 `import type` 提供（纯类型，不进 bundle）。
 */
const nodeRequire = eval("require") as (id: string) => unknown;
type DatabaseCtor = typeof BetterSqlite3;
let _Database: DatabaseCtor | null = null;
function loadDatabaseCtor(): DatabaseCtor {
  if (!_Database) {
    _Database = nodeRequire("better-sqlite3") as DatabaseCtor;
  }
  return _Database;
}

/**
 * 创建一个数据库实例并确保表结构存在。
 * 测试可传 ":memory:" 获得隔离的内存库（LLM/工具层单测不碰真实数据文件）。
 */
export function createDb(dbPath: string): Db {
  const Database = loadDatabaseCtor();
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(DDL);
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function defaultDbPath(): string {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, "ngplus.db");
}

let _db: Db | null = null;

/** 服务端默认单例（懒初始化，避免测试 import 时触碰真实数据文件） */
export function getDb(): Db {
  if (!_db) {
    _db = createDb(defaultDbPath());
  }
  return _db;
}

export { schema };
