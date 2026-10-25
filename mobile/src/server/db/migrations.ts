import type { SQLiteDatabase } from "expo-sqlite";

/**
 * 移动端增量迁移。
 * 全新安装由 DDL 直接建最终结构；这里只处理两类历史包袱：
 * 1. 早期 Expo 壳（chat_log 只有 id/role/content/created_at）→ 重建聊天表；
 * 2. 补齐索引与记忆/消息归属回填（幂等）。
 */
export function applyMigrations(sqlite: SQLiteDatabase): void {
  const chatCols = sqlite.prepareSync("PRAGMA table_info(chat_log)").executeSync().getAllSync() as {
    name: string;
  }[];
  const legacyChat = chatCols.length > 0 && !chatCols.some((c) => c.name === "user_id");
  if (legacyChat) {
    sqlite.execSync("DROP TABLE IF EXISTS chat_log");
    sqlite.execSync(`
      CREATE TABLE chat_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','master','system')),
        content TEXT NOT NULL,
        master_id TEXT,
        mode TEXT NOT NULL DEFAULT 'quest' CHECK (mode IN ('quest','chat')),
        session_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  sqlite.execSync(
    "CREATE INDEX IF NOT EXISTS idx_chat_log_user_mode_time ON chat_log(user_id, mode, created_at)",
  );
  sqlite.execSync(
    "CREATE INDEX IF NOT EXISTS idx_chat_log_user_mode_master_time ON chat_log(user_id, mode, master_id, created_at)",
  );
  sqlite.execSync(
    "CREATE INDEX IF NOT EXISTS idx_memory_user_master_time ON memory(user_id, master_id, created_at)",
  );
  sqlite.execSync(
    "CREATE INDEX IF NOT EXISTS idx_memory_user_session_time ON memory(user_id, session_id, created_at)",
  );
  sqlite.execSync(
    "CREATE INDEX IF NOT EXISTS idx_world_book_entries_book ON world_book_entries(user_id, book_id)",
  );

  // 旧记忆回填到当前会长（只填 NULL，幂等）
  sqlite.execSync(`
    UPDATE memory SET master_id = (
      SELECT s.active_master_id FROM saves s WHERE s.user_id = memory.user_id
    )
    WHERE master_id IS NULL
      AND EXISTS (
        SELECT 1 FROM saves s
        WHERE s.user_id = memory.user_id AND s.active_master_id IS NOT NULL
      )
  `);

  // 早期没有 master_id 的任务流用户消息：归给当前会长
  sqlite.execSync(`
    UPDATE chat_log
    SET master_id = (
      SELECT s.active_master_id FROM saves s WHERE s.user_id = chat_log.user_id
    )
    WHERE mode = 'quest' AND role = 'user' AND master_id IS NULL
      AND EXISTS (
        SELECT 1 FROM saves s
        WHERE s.user_id = chat_log.user_id AND s.active_master_id IS NOT NULL
      )
  `);
}
