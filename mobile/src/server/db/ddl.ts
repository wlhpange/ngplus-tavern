// DDL 严格对应 ，与 schema.ts 保持一致
// migrate.ts 与测试（内存库建表）共用本文件
export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS masters (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  persona_json TEXT NOT NULL,
  avatar TEXT,
  -- 形象参数（像素小人 descriptor JSON）；NULL = 未设置
  sprite TEXT,
  is_official INTEGER NOT NULL DEFAULT 0,
  -- P1 软删除：非空即已归档（从候选人列表隐藏，历史保留）
  archived_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saves (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  active_master_id TEXT REFERENCES masters(id),
  -- P12 聊天（酒馆）模式专用会长；NULL = 跟随 active_master_id
  chat_master_id TEXT REFERENCES masters(id),
  -- P11：亲密度移出 saves，改为 per-master 的 master_affinity 表
  onboarded_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS master_history (
  id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(id),
  master_id TEXT NOT NULL REFERENCES masters(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  farewell_letter TEXT
);

CREATE TABLE IF NOT EXISTS quests (
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
  -- V1.5 复核/异议管线需要任务类别做白名单校验（create_quest 落库）
  category TEXT,
  -- V1.8 签到委托（daily + 本标志）：每日首条消息引擎自动结算
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

CREATE TABLE IF NOT EXISTS character (
  user_id TEXT PRIMARY KEY,
  total_xp INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  vitality_xp INTEGER NOT NULL DEFAULT 0,
  mind_xp INTEGER NOT NULL DEFAULT 0,
  willpower_xp INTEGER NOT NULL DEFAULT 0,
  wealth_xp INTEGER NOT NULL DEFAULT 0,
  social_xp INTEGER NOT NULL DEFAULT 0,
  creativity_xp INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settlement_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quest_id TEXT REFERENCES quests(id),
  kind TEXT NOT NULL,
  completion_ratio REAL,
  confidence REAL,
  xp_awarded INTEGER NOT NULL,
  gold_awarded INTEGER NOT NULL,
  attr_split_json TEXT NOT NULL,
  adjustments_json TEXT,
  llm_reasoning TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- P12 记忆书：会长级永久记忆（session_id 空）或某段酒馆对话的私有记忆
  master_id TEXT,
  session_id TEXT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  -- 0 = 停用（保留但不注入提示词）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','master','system')),
  content TEXT NOT NULL,
  -- V0.5.1 该条消息由哪位会长发送（仅 role=master 时有值）
  master_id TEXT,
  -- P0 对话模式：quest=任务管线，chat=聊天（酒馆）管线；两条流完全隔离
  mode TEXT NOT NULL DEFAULT 'quest' CHECK (mode IN ('quest','chat')),
  -- P10 聊天会话 id（mode='chat' 时有值）
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  -- P10 聊天会话：同一会长可开多条独立对话；scene 为立绘/背景预留
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  master_id TEXT NOT NULL,
  title TEXT NOT NULL,
  scene TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title_key TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
  -- V1.5 应用级键值设置（如 llm.api_key / llm.base_url / llm.model）
  -- Key 只存本机数据库，优先于环境变量；接口层只回传掩码
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  -- V1.5 异议通道留痕（：双入口收束同一条管线）
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES settlement_log(id),
  quest_id TEXT REFERENCES quests(id),
  claim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','rejected')),
  resolution TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_skills (
  -- V3 被动技能解锁记录（技能目录在 economy_config.skills）
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_events (
  -- V3 每日随机事件：每天至多一条，day_key = 本地日期 YYYY-MM-DD
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world_books (
  -- P6 世界书书册：独立命名，可分配给多位会长（is_global=1 为全局书，唯一）
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_global INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS master_world_books (
  -- 书册 → 会长的分配（多对多）
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  master_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world_book_entries (
  -- P2 世界书条目；P6 起归属书册（book_id）而非直接归属会长
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

CREATE TABLE IF NOT EXISTS master_affinity (
  -- P11 亲密度改为「每会长一份」：只由任务页的送礼推进，换会长不清零、切回恢复
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  master_id TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  stage INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- ============================================================
-- 索引（V1.5 性优化）：热查询路径全部走索引，避免全表扫描+排序。
-- chat_log 只增不减：每条消息 loadHistory 按 user_id+created_at 倒序取 20 条。
-- settlement_log：面板对账（user_id+created_at）、file_dispute 定位（quest_id）、
--  软上限合计（user_id+created_at）。
-- quests：任务板按用户+状态分组、逾期巡检按 status+type 全量扫描。
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_chat_log_user_time ON chat_log(user_id, created_at);
-- P10 聊天会话索引
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_master ON chat_sessions(user_id, master_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_settlement_log_user_time ON settlement_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_settlement_log_quest ON settlement_log(quest_id);
CREATE INDEX IF NOT EXISTS idx_quests_user_status ON quests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_quests_status_type ON quests(status, type);
CREATE INDEX IF NOT EXISTS idx_memory_user_time ON memory(user_id, created_at);
-- 注：按会长取用的 idx_memory_user_master_time 在 applyMigrations 里建
--（master_id 是迁移新增列，DDL 阶段老库还没有该列）
CREATE INDEX IF NOT EXISTS idx_items_user_key ON items(user_id, item_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_skills_unique ON user_skills(user_id, skill_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_events_day ON daily_events(user_id, day_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_master_world_books_unique ON master_world_books(master_id, book_id);
CREATE INDEX IF NOT EXISTS idx_master_world_books_master ON master_world_books(user_id, master_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_master_affinity_unique ON master_affinity(user_id, master_id);
`;
