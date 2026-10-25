import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { drizzle, type ExpoSQLiteDatabase } from "drizzle-orm/expo-sqlite";
import * as schema from "./schema";
import { DDL } from "./ddl";
import { applyMigrations } from "./migrations";

export type Db = ExpoSQLiteDatabase<typeof schema>;

/** 移动端单库：数据全部留在本机 documents/SQLite/ngplus.db */
const DB_NAME = "ngplus.db";

let _db: Db | null = null;
let _client: SQLiteDatabase | null = null;

export function createDb(name: string = DB_NAME): Db {
  const client = openDatabaseSync(name);
  client.execSync("PRAGMA journal_mode = WAL;");
  client.execSync("PRAGMA foreign_keys = ON;");
  client.execSync(DDL);
  applyMigrations(client);
  return drizzle(client, { schema });
}

export function getDb(): Db {
  if (!_db) {
    _client = openDatabaseSync(DB_NAME);
    _client.execSync("PRAGMA journal_mode = WAL;");
    _client.execSync("PRAGMA foreign_keys = ON;");
    _client.execSync(DDL);
    applyMigrations(_client);
    _db = drizzle(_client, { schema });
  }
  return _db;
}

export function getSqlite(): SQLiteDatabase {
  getDb();
  return _client!;
}

export { schema };
