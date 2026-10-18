import type Database from "better-sqlite3";

/**
 * 增量列迁移（CREATE TABLE IF NOT EXISTS 管不到已有表的加列）。
 * createDb 与 db:migrate 共用；全部幂等，可反复执行。
 */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  // M5 冷启动完成标记
  { table: "saves", column: "onboarded_at", ddl: "ALTER TABLE saves ADD COLUMN onboarded_at INTEGER" },
  // M5 断签追踪
  { table: "quests", column: "break_streak", ddl: "ALTER TABLE quests ADD COLUMN break_streak INTEGER NOT NULL DEFAULT 0" },
  // M5 逾期巡检幂等标记
  { table: "quests", column: "last_checked_at", ddl: "ALTER TABLE quests ADD COLUMN last_checked_at INTEGER" },
  // V1.5 任务类别（复核/异议管线的白名单校验依据）
  { table: "quests", column: "category", ddl: "ALTER TABLE quests ADD COLUMN category TEXT" },
  // V1.8 签到委托标志
  { table: "quests", column: "checkin", ddl: "ALTER TABLE quests ADD COLUMN checkin INTEGER NOT NULL DEFAULT 0" },
  // V0.5.1 消息归属会长
  { table: "chat_log", column: "master_id", ddl: "ALTER TABLE chat_log ADD COLUMN master_id TEXT" },
  // P0 对话模式：quest=任务管线，chat=聊天（酒馆）管线
  { table: "chat_log", column: "mode", ddl: "ALTER TABLE chat_log ADD COLUMN mode TEXT NOT NULL DEFAULT 'quest'" },
  // P1 会长软删除（归档）
  { table: "masters", column: "archived_at", ddl: "ALTER TABLE masters ADD COLUMN archived_at INTEGER" },
  // 像素小人形象参数（descriptor JSON）
  { table: "masters", column: "sprite", ddl: "ALTER TABLE masters ADD COLUMN sprite TEXT" },
  // P10 聊天会话（酒馆式多会话）
  { table: "chat_log", column: "session_id", ddl: "ALTER TABLE chat_log ADD COLUMN session_id TEXT" },
  // P12 聊天（酒馆）模式专用会长
  { table: "saves", column: "chat_master_id", ddl: "ALTER TABLE saves ADD COLUMN chat_master_id TEXT" },
  // P12 记忆书：条目归属会长 + 可停用
  { table: "memory", column: "master_id", ddl: "ALTER TABLE memory ADD COLUMN master_id TEXT" },
  { table: "memory", column: "enabled", ddl: "ALTER TABLE memory ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1" },
  // P12 酒馆对话记忆：session_id 非空表示该条只属于这段对话
  { table: "memory", column: "session_id", ddl: "ALTER TABLE memory ADD COLUMN session_id TEXT" },
];

export function applyMigrations(sqlite: Database.Database): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = sqlite
      .prepare(`PRAGMA table_info(${m.table})`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) {
      sqlite.exec(m.ddl);
    }
  }
  // P0：mode 列建好后补索引（DDL 里不能建，老库建索引时该列还不存在）
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_chat_log_user_mode_time ON chat_log(user_id, mode, created_at)",
  );
  // P12 记忆书：按会长取用的索引；老记忆（master_id 为空）回填给当前在任会长，
  // 之后记忆按会长隔离。幂等（只填 NULL）。
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_memory_user_master_time ON memory(user_id, master_id, created_at)",
  );
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_memory_user_session_time ON memory(user_id, session_id, created_at)",
  );
  sqlite.exec(`
    UPDATE memory SET master_id = (
      SELECT s.active_master_id FROM saves s WHERE s.user_id = memory.user_id
    )
    WHERE master_id IS NULL
      AND EXISTS (
        SELECT 1 FROM saves s
        WHERE s.user_id = memory.user_id AND s.active_master_id IS NOT NULL
      )
  `);
  // P6：世界书从「绑会长」升级为「独立书册 + 多对多分配」
  migrateWorldBooks(sqlite);
  // 皮肤系统下线（V1.5 引入后收敛）：存量库删掉 saves.skin_key 列，
  // 并清空 items 里的皮肤持有记录（settlement_log 购买历史保留，金币对账不动）
  const saveCols = sqlite.prepare("PRAGMA table_info(saves)").all() as { name: string }[];
  if (saveCols.some((c) => c.name === "skin_key")) {
    sqlite.exec("ALTER TABLE saves DROP COLUMN skin_key");
  }
  sqlite.exec("DELETE FROM items WHERE item_key LIKE 'skin\\_%' ESCAPE '\\'");
  // 风格字段下线（V2.0）：motivation_style 不再使用，存量库删列
  const masterCols = sqlite.prepare("PRAGMA table_info(masters)").all() as { name: string }[];
  if (masterCols.some((c) => c.name === "motivation_style")) {
    sqlite.exec("ALTER TABLE masters DROP COLUMN motivation_style");
  }
  // 通知功能下线（V1.9）：删掉 users 的通知时间列与 Web Push 订阅表
  const userCols = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  for (const col of ["notify_hour", "notify_minute"]) {
    if (userCols.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE users DROP COLUMN ${col}`);
    }
  }
  sqlite.exec("DROP TABLE IF EXISTS push_subscriptions");
  // 全局世界书下线：删掉 is_global=1 的书册与其条目（用户决定世界书只随角色卡走）
  const wbCols = sqlite.prepare("PRAGMA table_info(world_books)").all() as { name: string }[];
  if (wbCols.some((c) => c.name === "is_global")) {
    sqlite.exec(`
      DELETE FROM world_book_entries WHERE book_id IN (SELECT id FROM world_books WHERE is_global = 1);
      DELETE FROM master_world_books WHERE book_id IN (SELECT id FROM world_books WHERE is_global = 1);
      DELETE FROM world_books WHERE is_global = 1;
    `);
  }
  // V2.0 主线：quests.type 的 CHECK 需要容纳 'mainline'。
  // SQLite 无法修改 CHECK 约束 → 检测旧表结构后整表重建（列顺序与 ddl.ts 逐字一致），
  // 重建会带走索引，随后按名重建。
  const questsSql =
    (
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quests'")
        .get() as { sql?: string } | undefined
    )?.sql ?? "";
  if (questsSql && !questsSql.includes("'mainline'")) {
    // 上次迁移中断可能留下半成品（CREATE 成功后失败），先清理
    sqlite.exec("DROP TABLE IF EXISTS quests_v2");
    // 表重建必须临时关闭外键：settlement_log / disputes 以 quest_id 引用本表，
    // better-sqlite3 默认 foreign_keys=ON，DROP 会被外键拦下（真实踩坑）。
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.exec(`
      CREATE TABLE quests_v2 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL CHECK (type IN ('daily','once','weekly','mainline','mainline_milestone')),
        primary_attr TEXT NOT NULL CHECK (primary_attr IN ('vitality','mind','willpower','wealth','social','creativity')),
        primary_weight REAL NOT NULL DEFAULT 1.0,
        secondary_attr TEXT CHECK (secondary_attr IN ('vitality','mind','willpower','wealth','social','creativity')),
        secondary_weight REAL,
        attr_reason TEXT,
        category TEXT,
        checkin INTEGER NOT NULL DEFAULT 0,
        difficulty REAL NOT NULL DEFAULT 1.0,
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed','active','completed','overdue','abandoned','rejected')),
        streak INTEGER NOT NULL DEFAULT 0,
        break_streak INTEGER NOT NULL DEFAULT 0,
        last_checked_at INTEGER,
        deadline INTEGER,
        parent_quest_id TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      INSERT INTO quests_v2 (
        id, user_id, title, description, type, primary_attr, primary_weight,
        secondary_attr, secondary_weight, attr_reason, category, checkin,
        difficulty, status, streak, break_streak, last_checked_at, deadline,
        parent_quest_id, created_at, completed_at
      )
      SELECT
        id, user_id, title, description, type, primary_attr, primary_weight,
        secondary_attr, secondary_weight, attr_reason, category, checkin,
        difficulty, status, streak, break_streak, last_checked_at, deadline,
        parent_quest_id, created_at, completed_at
      FROM quests;
      DROP TABLE quests;
      ALTER TABLE quests_v2 RENAME TO quests;
      CREATE INDEX IF NOT EXISTS idx_quests_user_status ON quests(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_quests_status_type ON quests(status, type);
      `);
    } finally {
      // 无论成败都还原约束，避免影响后续迁移与运行期写入
      sqlite.pragma("foreign_keys = ON");
    }
  }
  // M5 冷启动标记回填：已有委托或聊天记录的老用户视为已完成冷启动，
  // 不让他们再看到推门页
  sqlite.exec(`
    UPDATE saves SET onboarded_at = created_at
    WHERE onboarded_at IS NULL AND (
      EXISTS (SELECT 1 FROM quests WHERE quests.user_id = saves.user_id)
      OR EXISTS (SELECT 1 FROM chat_log WHERE chat_log.user_id = saves.user_id)
    )
  `);
  // 任务流按会长分：老的用户消息没有 master_id。用 master_history 任期把它归到
  // 当时在任的会长；任期没覆盖到的（建档前）兜底归当前在任会长。幂等（只填 NULL）。
  sqlite.exec(`
    UPDATE chat_log
    SET master_id = (
      SELECT mh.master_id
      FROM master_history mh
      JOIN saves s ON s.id = mh.save_id
      WHERE s.user_id = chat_log.user_id
        AND mh.started_at <= chat_log.created_at
        AND (mh.ended_at IS NULL OR chat_log.created_at < mh.ended_at)
      ORDER BY mh.started_at DESC
      LIMIT 1
    )
    WHERE chat_log.mode = 'quest' AND chat_log.role = 'user' AND chat_log.master_id IS NULL
  `);
  sqlite.exec(`
    UPDATE chat_log
    SET master_id = (
      SELECT s.active_master_id FROM saves s WHERE s.user_id = chat_log.user_id
    )
    WHERE chat_log.mode = 'quest' AND chat_log.role = 'user' AND chat_log.master_id IS NULL
      AND EXISTS (
        SELECT 1 FROM saves s
        WHERE s.user_id = chat_log.user_id AND s.active_master_id IS NOT NULL
      )
  `);
  // 任务流按（user, mode, master, time）取历史/分页：补一个索引
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_chat_log_user_mode_master_time ON chat_log(user_id, mode, master_id, created_at)",
  );

  // P11 亲密度改为「每会长一份」：把老的 saves.intimacy_* 迁给当前在任会长，
  // 然后删掉旧列（幂等；master_affinity 由 DDL 建好）。
  const hasIntimacyCols =
    saveCols.some((c) => c.name === "intimacy_points") ||
    saveCols.some((c) => c.name === "intimacy_stage");
  if (hasIntimacyCols) {
    sqlite.exec(`
      INSERT INTO master_affinity (id, user_id, master_id, points, stage, updated_at)
      SELECT 'aff_' || s.user_id || '_' || s.active_master_id,
             s.user_id, s.active_master_id,
             COALESCE(s.intimacy_points, 0), COALESCE(s.intimacy_stage, 1), ${Date.now()}
      FROM saves s
      WHERE s.active_master_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM master_affinity ma
          WHERE ma.user_id = s.user_id AND ma.master_id = s.active_master_id
        )
    `);
  }
  if (saveCols.some((c) => c.name === "intimacy_stage")) {
    sqlite.exec("ALTER TABLE saves DROP COLUMN intimacy_stage");
  }
  if (saveCols.some((c) => c.name === "intimacy_points")) {
    sqlite.exec("ALTER TABLE saves DROP COLUMN intimacy_points");
  }
}

/**
 * P6 世界书模型升级：world_book_entries.master_id → book_id（书册化）。
 * 幂等：
 * 1. 建 world_books / master_world_books；
 * 2. entries 缺 book_id 时加列（可空），把旧 master_id 数据迁成书册：
 *    - NULL → 「全局世界书」；非 NULL → 「<会长名>的世界书」并分配给该会长；
 * 3. 已迁完（无 book_id 为空的行）后重建表，把 book_id 约束为 NOT NULL。
 */
function migrateWorldBooks(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS world_books (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_global INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS master_world_books (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      master_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_master_world_books_unique ON master_world_books(master_id, book_id);
    CREATE INDEX IF NOT EXISTS idx_master_world_books_master ON master_world_books(user_id, master_id);
  `);

  const cols = sqlite
    .prepare("PRAGMA table_info(world_book_entries)")
    .all() as { name: string }[];
  if (cols.length === 0) return; // 新库：DDL 已建好 book_id 列

  if (!cols.some((c) => c.name === "book_id")) {
    sqlite.exec("ALTER TABLE world_book_entries ADD COLUMN book_id TEXT");
  }
  // P6 索引在 book_id 建好之后补（DDL 里不能建，老库建索引时该列还不存在）
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_world_book_entries_book ON world_book_entries(user_id, book_id)",
  );

  // 找出「还没迁」的行：book_id 为空但 master_id 有值（或原本没有 master_id 概念）
  const hasMasterId = cols.some((c) => c.name === "master_id");
  const pending = sqlite
    .prepare(
      `SELECT DISTINCT user_id, ${hasMasterId ? "master_id" : "NULL"} AS master_id
       FROM world_book_entries WHERE book_id IS NULL`,
    )
    .all() as { user_id: string; master_id: string | null }[];

  for (const p of pending) {
    const bookId = `wb_${p.user_id}_${p.master_id ?? "global"}`;
    const name = p.master_id
      ? ((
          sqlite
            .prepare("SELECT name FROM masters WHERE id = ?")
            .get(p.master_id) as { name?: string } | undefined
        )?.name ?? "未命名") + "的世界书"
      : "全局世界书";
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO world_books (id, user_id, name, is_global, created_at) VALUES (?,?,?,?,?)",
      )
      .run(bookId, p.user_id, name, p.master_id ? 0 : 1, Date.now());
    if (p.master_id) {
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO master_world_books (id, user_id, master_id, book_id, created_at) VALUES (?,?,?,?,?)",
        )
        .run(`mwb_${p.master_id}_${bookId}`, p.user_id, p.master_id, bookId, Date.now());
    }
    if (hasMasterId) {
      sqlite
        .prepare(
          p.master_id
            ? "UPDATE world_book_entries SET book_id = ? WHERE book_id IS NULL AND user_id = ? AND master_id = ?"
            : "UPDATE world_book_entries SET book_id = ? WHERE book_id IS NULL AND user_id = ? AND master_id IS NULL",
        )
        .run(
          ...[bookId, p.user_id, ...(p.master_id ? [p.master_id] : [])],
        );
    } else {
      sqlite
        .prepare("UPDATE world_book_entries SET book_id = ? WHERE book_id IS NULL AND user_id = ?")
        .run(bookId, p.user_id);
    }
  }

  // 重建表把 book_id 收紧为 NOT NULL（仅当确实存在可空结构时）
  const freshCols = sqlite
    .prepare("PRAGMA table_info(world_book_entries)")
    .all() as { name: string; notnull: number }[];
  const bookCol = freshCols.find((c) => c.name === "book_id");
  if (bookCol && bookCol.notnull === 0) {
    sqlite.exec(`
      DROP TABLE IF EXISTS world_book_entries_v2;
      CREATE TABLE world_book_entries_v2 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        keys TEXT NOT NULL DEFAULT '[]',
        secondary_keys TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        constant INTEGER NOT NULL DEFAULT 0,
        selective INTEGER NOT NULL DEFAULT 0,
        insertion_order INTEGER NOT NULL DEFAULT 100,
        position TEXT NOT NULL DEFAULT 'before',
        depth INTEGER NOT NULL DEFAULT 4,
        role TEXT NOT NULL DEFAULT 'system',
        priority INTEGER,
        case_sensitive INTEGER,
        use_regex INTEGER NOT NULL DEFAULT 0,
        scan_depth INTEGER,
        extensions TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      INSERT INTO world_book_entries_v2 (
        id, user_id, book_id, keys, secondary_keys, content, enabled, constant,
        selective, insertion_order, position, depth, role, priority,
        case_sensitive, use_regex, scan_depth, extensions, created_at
      )
      SELECT
        id, user_id, COALESCE(book_id, 'wb_' || user_id || '_global'),
        keys, secondary_keys, content, enabled, constant,
        selective, insertion_order, position, depth, role, priority,
        case_sensitive, use_regex, scan_depth, extensions, created_at
      FROM world_book_entries;
      DROP TABLE world_book_entries;
      ALTER TABLE world_book_entries_v2 RENAME TO world_book_entries;
      CREATE INDEX IF NOT EXISTS idx_world_book_entries_book ON world_book_entries(user_id, book_id);
    `);
  }
}
