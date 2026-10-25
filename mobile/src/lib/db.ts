import * as SQLite from "expo-sqlite";

/**
 * 本地 SQLite（首版只建聊天与设置两张表）。
 * 后续移植委托/结算/记忆时，在这里补表与迁移。
 */
let database: SQLite.SQLiteDatabase | null = null;

export function getDb(): SQLite.SQLiteDatabase {
  if (database) return database;
  database = SQLite.openDatabaseSync("ngplus.db");
  database.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_log (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_log_created ON chat_log(created_at);
  `);
  return database;
}

export function initDb(): void {
  getDb();
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getSetting(key: string): string | null {
  const row = getDb().getFirstSync<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().runSync(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    Date.now(),
  );
}

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export function listMessages(limit = 200): StoredMessage[] {
  const rows = getDb().getAllSync<{
    id: string;
    role: string;
    content: string;
    created_at: number;
  }>(
    "SELECT id, role, content, created_at FROM chat_log ORDER BY created_at ASC LIMIT ?",
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role === "user" ? "user" : "assistant",
    content: r.content,
    createdAt: r.created_at,
  }));
}

export function addMessage(m: StoredMessage): void {
  getDb().runSync(
    "INSERT INTO chat_log (id, role, content, created_at) VALUES (?, ?, ?, ?)",
    m.id,
    m.role,
    m.content,
    m.createdAt,
  );
}

export function updateMessageContent(id: string, content: string): void {
  getDb().runSync("UPDATE chat_log SET content = ? WHERE id = ?", content, id);
}

export function deleteMessage(id: string): void {
  getDb().runSync("DELETE FROM chat_log WHERE id = ?", id);
}
