import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { DDL } from "./ddl";
import { applyMigrations } from "./migrations";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH ?? path.join(dataDir, "ngplus.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(DDL);
applyMigrations(db);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];
console.log(`[db:migrate] ${dbPath}`);
console.log(`[db:migrate] tables: ${tables.map((t) => t.name).join(", ")}`);
db.close();
