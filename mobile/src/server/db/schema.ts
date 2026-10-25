import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// 表结构严格对应 ；migrate.ts 中的 DDL 与本文件保持一致

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

export const masters = sqliteTable("masters", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"), // NULL = 官方人格
  name: text("name").notNull(),
  personaJson: text("persona_json").notNull(),
  avatar: text("avatar"),
  /** 形象参数（像素小人 descriptor JSON 字符串）；NULL = 未设置 */
  sprite: text("sprite"),
  isOfficial: integer("is_official").notNull().default(0),
  /** P1 软删除：非空即已归档，从候选人列表隐藏；历史/消息仍可解析其名 */
  archivedAt: integer("archived_at"),
  createdAt: integer("created_at").notNull(),
});

export const saves = sqliteTable("saves", {
  id: text("id").primaryKey(),
  userId: text("user_id")
  .notNull()
  .references(() => users.id),
  activeMasterId: text("active_master_id").references(() => masters.id),
  /**
   * P12 聊天（酒馆）模式专用会长；NULL = 跟随 activeMasterId（两个模式同一位会长）。
   * 任务模式始终用 active_master_id。记忆按会长隔离，两者相同即自动共享记忆书。
   */
  chatMasterId: text("chat_master_id").references(() => masters.id),
  // P11：亲密度移出 saves，改为 per-master 的 master_affinity 表
  // M5 冷启动完成标记：NULL = 新用户（走三幕流程）
  onboardedAt: integer("onboarded_at"),
  createdAt: integer("created_at").notNull(),
});

export const masterHistory = sqliteTable("master_history", {
  id: text("id").primaryKey(),
  saveId: text("save_id")
  .notNull()
  .references(() => saves.id),
  masterId: text("master_id")
  .notNull()
  .references(() => masters.id),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  farewellLetter: text("farewell_letter"),
});

export const quests = sqliteTable("quests", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type", {
  enum: ["daily", "once", "weekly", "mainline", "mainline_milestone"],
  }).notNull(),
  primaryAttr: text("primary_attr", {
  enum: ["vitality", "mind", "willpower", "wealth", "social", "creativity"],
  }).notNull(),
  primaryWeight: real("primary_weight").notNull().default(1.0),
  secondaryAttr: text("secondary_attr", {
  enum: ["vitality", "mind", "willpower", "wealth", "social", "creativity"],
  }),
  secondaryWeight: real("secondary_weight"),
  attrReason: text("attr_reason"),
  // V1.5 任务类别：复核/异议管线的白名单校验依据（create_quest 落库）
  category: text("category"),
  // V1.8 签到委托（daily + 本标志）：每日首条消息由引擎自动结算，无需汇报
  checkin: integer("checkin").notNull().default(0),
  difficulty: real("difficulty").notNull().default(1.0),
  status: text("status", {
  enum: ["proposed", "active", "completed", "overdue", "abandoned", "rejected"],
  })
  .notNull()
  .default("proposed"),
  streak: integer("streak").notNull().default(0),
  // M5 断签追踪：连续断签天数（0=正常；1=已断一天，下次结算加成减半）
  breakStreak: integer("break_streak").notNull().default(0),
  // M5 逾期巡检幂等标记：最近一次断签巡检时间
  lastCheckedAt: integer("last_checked_at"),
  deadline: integer("deadline"),
  parentQuestId: text("parent_quest_id"),
  createdAt: integer("created_at").notNull(),
  completedAt: integer("completed_at"),
});

export const character = sqliteTable("character", {
  userId: text("user_id").primaryKey(),
  totalXp: integer("total_xp").notNull().default(0),
  gold: integer("gold").notNull().default(0),
  vitalityXp: integer("vitality_xp").notNull().default(0),
  mindXp: integer("mind_xp").notNull().default(0),
  willpowerXp: integer("willpower_xp").notNull().default(0),
  wealthXp: integer("wealth_xp").notNull().default(0),
  socialXp: integer("social_xp").notNull().default(0),
  creativityXp: integer("creativity_xp").notNull().default(0),
});

export const settlementLog = sqliteTable("settlement_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  questId: text("quest_id").references(() => quests.id),
  kind: text("kind").notNull(),
  completionRatio: real("completion_ratio"),
  confidence: real("confidence"),
  xpAwarded: integer("xp_awarded").notNull(),
  goldAwarded: integer("gold_awarded").notNull(),
  attrSplitJson: text("attr_split_json").notNull(),
  adjustmentsJson: text("adjustments_json"),
  llmReasoning: text("llm_reasoning"),
  createdAt: integer("created_at").notNull(),
});

export const memory = sqliteTable("memory", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /**
   * P12 记忆书：条目归属的会长。
   * - session_id 为空 = 会长级「永久记忆」（任务管线写入，始终只保留一本）；
   * - session_id 非空 = 某段酒馆对话的私有记忆（各对话互不共享）。
   * NULL = 历史遗留（迁移时回填给当时在任会长）。
   */
  masterId: text("master_id"),
  /** P12 酒馆对话记忆：指向 chat_sessions.id；NULL = 会长级永久记忆 */
  sessionId: text("session_id"),
  category: text("category").notNull(),
  content: text("content").notNull(),
  /** 0 = 停用（保留在记忆书里，但不注入提示词） */
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});

export const chatLog = sqliteTable("chat_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["user", "master", "system"] }).notNull(),
  content: text("content").notNull(),
  /** V0.5.1 该条消息由哪位会长发送（仅 role=master 时有值） */
  masterId: text("master_id"),
  /**
   * P0 对话模式：quest=任务管线（委托/结算），chat=聊天（酒馆式自由 RP）。
   * 两条流完全隔离，查询必须按 mode 过滤；亲密度是唯一的共享状态。
   */
  mode: text("mode", { enum: ["quest", "chat"] }).notNull().default("quest"),
  /**
   * P10 聊天会话：mode='chat' 时指向 chat_sessions.id；任务流恒为 NULL。
   * 同一会长可开多条互不干扰的会话。
   */
  sessionId: text("session_id"),
  createdAt: integer("created_at").notNull(),
});

/**
 * P10 聊天会话（酒馆式多会话）：同一会长可开多条独立对话。
 * 每段会话有自己的历史；scene 为后续立绘/背景预留。
 */
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** 所属会长；换会长后旧会话仍归原会长（只在该会长任内可见） */
  masterId: text("master_id").notNull(),
  title: text("title").notNull(),
  /** 预留：场景/立绘标识（美术资产到位后使用） */
  scene: text("scene"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** 软删除：非空即已归档 */
  archivedAt: integer("archived_at"),
});

/**
 * P11 亲密度（每会长一份）：只由任务页的送礼推进。
 * 与聊天（酒馆）模式解耦；换会长不清零，切回旧会长恢复原值。
 */
export const masterAffinity = sqliteTable("master_affinity", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  masterId: text("master_id").notNull(),
  points: integer("points").notNull().default(0),
  stage: integer("stage").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

export const titles = sqliteTable("titles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  titleKey: text("title_key").notNull(),
  grantedAt: integer("granted_at").notNull(),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  itemKey: text("item_key").notNull(),
  count: integer("count").notNull().default(0),
});

// V1.5 应用级键值设置（模型配置等）；value 由各模块自行解释
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// V1.5 异议通道留痕（：双入口收束同一条管线）
export const disputes = sqliteTable("disputes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  settlementId: text("settlement_id")
  .notNull()
  .references(() => settlementLog.id),
  questId: text("quest_id").references(() => quests.id),
  /** 用户的主张（对话原话或任务卡按钮代发的一句话） */
  claim: text("claim").notNull(),
  status: text("status", { enum: ["open", "upheld", "rejected"] })
  .notNull()
  .default("open"),
  /** 裁决说明（复核判定器的 narrative_hint 或拒绝理由） */
  resolution: text("resolution"),
  createdAt: integer("created_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

// V3 被动技能解锁记录（金币 + 等级；技能目录在 economy_config.skills）
export const userSkills = sqliteTable("user_skills", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  skillKey: text("skill_key").notNull(),
  unlockedAt: integer("unlocked_at").notNull(),
});

// V3 每日随机事件（每天至多一条；效果由各消费方读取）
export const dailyEvents = sqliteTable("daily_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** 本地日期键 YYYY-MM-DD */
  dayKey: text("day_key").notNull(),
  eventKey: text("event_key").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * P6 世界书书册：独立命名，可分配给多位会长（也可为全局书）。
 * - is_global=1：全局世界书（所有会长共用，唯一一本）
 * - 其余：命名书册，通过 master_world_books 分配给任意多位会长
 */
export const worldBooks = sqliteTable("world_books", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  isGlobal: integer("is_global").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

/** 书册 → 会长的分配（多对多：一本书可给多个角色，一个角色可挂多本） */
export const masterWorldBooks = sqliteTable("master_world_books", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  masterId: text("master_id").notNull(),
  bookId: text("book_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * P2 世界书条目（Lorebook）：对齐 Character Card V2/V3 的 Lorebook 子集。
 * - book_id 指向 world_books（书册化后，条目归属书册而非直接归属会长）；
 * - keys / secondary_keys / extensions 以 JSON 字符串保存（SQLite 无原生数组）；
 * - 不认识的字段一律原样塞进 extensions，导出/再导入不丢失。
 */
export const worldBookEntries = sqliteTable("world_book_entries", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** 所属书册 id（world_books.id） */
  bookId: text("book_id").notNull(),
  /** 触发关键词（JSON 字符串数组） */
  keys: text("keys").notNull().default("[]"),
  /** 次级关键词（JSON 字符串数组，selective 时使用） */
  secondaryKeys: text("secondary_keys").notNull().default("[]"),
  content: text("content").notNull(),
  enabled: integer("enabled").notNull().default(1),
  constant: integer("constant").notNull().default(0),
  selective: integer("selective").notNull().default(0),
  insertionOrder: integer("insertion_order").notNull().default(100),
  /** before / after / at_depth */
  position: text("position").notNull().default("before"),
  /** at_depth 时插入到倒数第几条消息之前 */
  depth: integer("depth").notNull().default(4),
  /** at_depth 时的注入角色 */
  role: text("role").notNull().default("system"),
  priority: integer("priority"),
  caseSensitive: integer("case_sensitive"),
  useRegex: integer("use_regex").notNull().default(0),
  scanDepth: integer("scan_depth"),
  /** 未支持的 CC/ST 字段原样保留 */
  extensions: text("extensions").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});
