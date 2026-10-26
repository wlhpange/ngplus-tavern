import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { randomUUID } from "./util/id";
import type { Db } from "./db";
import { masters, masterHistory, saves, chatLog, masterAffinity } from "./db/schema";
import { config } from "./engine/config";
import { startOfDayTs } from "./util/time";
import type { PersonaJson } from "./llm/prompts";
import { normalizeCard, parseCard, normalizeRelationshipStages } from "./cards";
import type { ImportedCard } from "./cardImport";
import { deleteAsset, isSafeAssetName } from "./assets";
import { replaceMasterBookFromCharacterBook, removeMasterBooks } from "./worldbook";
import { purgeMasterChatData } from "./chatSessions";

/** 头像文件名兜底：只接受安全文件名（真实存在性由写入方保证） */
function normalizeAvatarName(value: string | null | undefined): string | null {
  const name = value?.trim();
  return name && isSafeAssetName(name) ? name : null;
}

/**
 * M4 人设系统：官方人格列表 + 会长热切换（交接仪式，）
 * 人设是数据：人格卡读 masters.persona_json，本文件不含任何人设文案。
 */

export interface MasterCard {
  id: string;
  name: string;
  persona: PersonaJson;
  /** 会长头像文件名（存于 data/avatars/）；null = 用名字首字兜底 */
  avatar: string | null;
  isOfficial: boolean;
  /** P1：用户指名邀请的会长（owner_id = userId），可归档删除 */
  isCustom: boolean;
}

export interface SaveState {
  saveId: string;
  activeMasterId: string | null;
  intimacyStage: number;
  /** V2.0 亲密度经验值（送礼累积） */
  intimacyPoints: number;
  /**
  * 亲密度展示标签。DESIGN-DECISION: 文档 §7 的「初识+」不加表字段，
  * 用 intimacy_stage=1 + 「master_history 存在已结束任期」推导：
  * 档案都在协会卷宗室，新会长与冒险者并非真正初见，故标「初识+」。
  */
  intimacyLabel: string;
}

/** 官方人格列表（选人界面用；不含已归档的） */
export function listSelectableMasters(db: Db, userId: string): MasterCard[] {
  // V1.9 指名邀请：可选会长 = 官方人格 + 本人指名的自定义会长（owner_id = userId）。
  // 他人自定义的会长不可见（V2 多用户时的隔离语义在此预埋）。
  // P1：已归档（软删除）的会长不出现在候选列表。
  return db
  .select()
  .from(masters)
  .where(
  and(
  isNull(masters.archivedAt),
  or(eq(masters.isOfficial, 1), eq(masters.ownerId, userId)),
  ),
  )
  .all()
  .map((m) => ({
  id: m.id,
  name: m.name,
  persona: parseCard(m.personaJson),
  avatar: m.avatar ?? null,
  isOfficial: m.isOfficial === 1,
  isCustom: m.ownerId != null,
  }));
}

const INTIMACY_LABELS: Record<number, string> = {
  1: "初识",
  2: "熟络",
  3: "挚友",
  4: "恋人",
};

/** 亲密度阶段展示标签（未知阶段兜底「初识」） */
export function intimacyLabel(stage: number): string {
  return INTIMACY_LABELS[stage] ?? "初识";
}

/**
 * 亲密度经验值 → 阶段。阈值来自 economy_config.intimacy.stages（配置驱动）。
 */
export function intimacyStageFromPoints(points: number): number {
  let stage = 1;
  for (const s of config.intimacy.stages) {
    if (points >= s.min_points) stage = s.stage;
  }
  return stage;
}

export interface ChatIntimacyResult {
  pointsAdded: number;
  stageChanged: boolean;
  fromStage: number;
  toStage: number;
  points: number;
}

export interface MasterAffinity {
  masterId: string;
  points: number;
  stage: number;
  label: string;
}

/** 某会长的亲密度（无记录 = 初识 / 0 点）。P11：每会长一份，与聊天模式解耦 */
export function getAffinity(db: Db, userId: string, masterId: string): MasterAffinity {
  const row = db
    .select()
    .from(masterAffinity)
    .where(and(eq(masterAffinity.userId, userId), eq(masterAffinity.masterId, masterId)))
    .get();
  const points = row?.points ?? 0;
  const stage = row?.stage ?? intimacyStageFromPoints(points);
  return { masterId, points, stage, label: INTIMACY_LABELS[stage] ?? "初识" };
}

/**
 * 推进某会长的亲密度经验（合计 = 送礼经验；阈值见 economy_config.intimacy）。
 * 只由任务页的送礼调用——聊天（酒馆）模式不再影响亲密度。
 */
export function addAffinityPoints(
  db: Db,
  userId: string,
  masterId: string,
  points: number,
): ChatIntimacyResult {
  const before = getAffinity(db, userId, masterId);
  const pointsTotal = before.points + points;
  const stageAfter = intimacyStageFromPoints(pointsTotal);
  const existing = db
    .select({ id: masterAffinity.id })
    .from(masterAffinity)
    .where(and(eq(masterAffinity.userId, userId), eq(masterAffinity.masterId, masterId)))
    .get();
  if (existing) {
    db.update(masterAffinity)
      .set({ points: pointsTotal, stage: stageAfter, updatedAt: Date.now() })
      .where(eq(masterAffinity.id, existing.id))
      .run();
  } else {
    db.insert(masterAffinity)
      .values({
        id: randomUUID(),
        userId,
        masterId,
        points: pointsTotal,
        stage: stageAfter,
        updatedAt: Date.now(),
      })
      .run();
  }
  return {
    pointsAdded: points,
    stageChanged: stageAfter !== before.stage,
    fromStage: before.stage,
    toStage: stageAfter,
    points: pointsTotal,
  };
}

/** 冷启动是否已完成（M5：saves.onboarded_at 非空即完成） */
export function isOnboarded(db: Db, userId: string): boolean {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  return save?.onboardedAt != null;
}

/**
 * 标记冷启动完成（幂等）。
 * 触发点（三幕）：用户选定会长进入协会时。
 * DESIGN-DECISION: 标记写在前端第一次对话时而非推门时——推门是纯前端动画，
 * 用户可能推完就关掉；真正"人到了"的时刻是已经站在会长面前。
 */
export function markOnboarded(db: Db, userId: string, now = Date.now()): boolean {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) return false;
  if (save.onboardedAt != null) return false;
  db.update(saves).set({ onboardedAt: now }).where(eq(saves.id, save.id)).run();
  return true;
}

/**
 * P12 聊天（酒馆）模式使用的会长：优先 saves.chat_master_id，
 * 未设置则跟随任务会长（active_master_id）。
 */
export function getChatMasterId(db: Db, userId: string): string | null {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) return null;
  return save.chatMasterId ?? save.activeMasterId ?? null;
}

/** 聊天会长的「显式设置」：null = 跟随任务会长（设置页选择器用） */
export function getChatMasterSetting(db: Db, userId: string): string | null {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  return save?.chatMasterId ?? null;
}

/** 任务会长（active_master_id），设置页展示用 */
export function getActiveMasterId(db: Db, userId: string): string | null {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  return save?.activeMasterId ?? null;
}

/**
 * 设置 / 清除「聊天专用会长」。传 null = 跟随任务会长。
 * 只影响聊天模式；任务模式与历史归属不受影响。返回是否成功。
 */
export function setChatMaster(db: Db, userId: string, masterId: string | null): boolean {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) return false;
  if (masterId) {
    const exists = db
      .select({ id: masters.id })
      .from(masters)
      .where(and(eq(masters.id, masterId), isNull(masters.archivedAt)))
      .get();
    if (!exists) return false;
  }
  db.update(saves).set({ chatMasterId: masterId }).where(eq(saves.id, save.id)).run();
  return true;
}

/** 当前存档的会长状态（含「初识+」推导） */
export function getSaveState(db: Db, userId: string): SaveState | null {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) return null;
  const pastTenures = db
  .select()
  .from(masterHistory)
  .where(eq(masterHistory.saveId, save.id))
  .all()
  .filter((h) => h.endedAt !== null).length;
  // P11：亲密度按当前会长取（无记录 = 初识 / 0 点）
  const affinity = save.activeMasterId
  ? getAffinity(db, userId, save.activeMasterId)
  : { stage: 1, points: 0 };
  const base = INTIMACY_LABELS[affinity.stage] ?? "初识";
  return {
  saveId: save.id,
  activeMasterId: save.activeMasterId,
  intimacyStage: affinity.stage,
  intimacyPoints: affinity.points,
  intimacyLabel:
  affinity.stage === 1 && pastTenures > 0 ? "初识+" : base,
  };
}

export interface SwitchResult {
  changed: boolean;
  previousMasterId: string | null;
  activeMasterId: string;
}

/**
 * 会长热切换（交接仪式）：
 * 1. 老会长任期写入 master_history（ended_at）
 * 2. 新会长开启新任期（started_at）
 * 3. saves.active_master_id 切换（P11：亲密度按会长各存一份，不重置）
 * 4. memory 表不动——档案存在协会卷宗室，不随会长走
 *
 * V2.0：取消 LLM 告别信（冗余且拖慢切换）——切换即时完成，不再等模型。
 */
export async function switchMaster(
  db: Db,
  userId: string,
  newMasterId: string,
): Promise<SwitchResult> {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save) throw new Error(`存档不存在：${userId}`);

  const newMaster = db
  .select()
  .from(masters)
  .where(eq(masters.id, newMasterId))
  .get();
  if (!newMaster) throw new Error(`会长不存在：${newMasterId}`);

  const previousMasterId = save.activeMasterId;
  if (previousMasterId === newMasterId) {
  return {
  changed: false,
  previousMasterId,
  activeMasterId: newMasterId,
  };
  }

  const now = Date.now();

  // 1. 结束老会长任期
  if (previousMasterId) {
  const closed = db
  .update(masterHistory)
  .set({ endedAt: now })
  .where(
  and(
  eq(masterHistory.saveId, save.id),
  eq(masterHistory.masterId, previousMasterId),
  isNull(masterHistory.endedAt),
  ),
  )
  .run();
  // DESIGN-DECISION: 旧存档可能缺初始任期行（种子未落库），补录一条完整
  // 任期（started_at 取存档创建时间），保证历任记录不丢失
  if (closed.changes === 0) {
  db.insert(masterHistory)
  .values({
  id: randomUUID(),
  saveId: save.id,
  masterId: previousMasterId,
  startedAt: save.createdAt,
  endedAt: now,
  })
  .run();
  }
  }

  // 2. 新会长开启任期
  db.insert(masterHistory)
  .values({
  id: randomUUID(),
  saveId: save.id,
  masterId: newMasterId,
  startedAt: now,
  })
  .run();

  // 3. 切换会长。P11：亲密度不再重置——每位会长各有一份（master_affinity），
  //    换新会长从初识开始，切回旧会长恢复原值
  db.update(saves)
  .set({ activeMasterId: newMasterId })
  .where(eq(saves.id, save.id))
  .run();

  // 4. memory 表刻意不动（：记忆挂在协会上）

  return {
  changed: true,
  previousMasterId,
  activeMasterId: newMasterId,
  };
}

// ============================================================================
// V1.9 指名邀请（第五扇门）：用户指名任意角色来执掌协会。
// LLM 负责把用户的一段描述锻造成结构化人格卡（persona_json，人设是数据），
// 校验与落库在本文件——LLM 生成物只有通过 createCustomMaster 才会生效。
// ============================================================================

export interface InviteInput {
  /** 会长名字（1–12 字） */
  name: string;
  /** 用户的一段描述：想要什么样的会长 */
  brief: string;
}

export interface CustomMasterInput extends InviteInput {
  persona: PersonaJson;
  /** 头像文件名（可选） */
  avatar?: string | null;
}

// 关系阶段合并逻辑统一放在 cards.ts（四档：初识/熟络/挚友/恋人）；
// 这里 re-export 保持既有调用方与测试的 import 路径不变。
export { normalizeRelationshipStages } from "./cards";

/** 校验并落库一位自定义会长（owner_id = 指名者） */
export function createCustomMaster(
  db: Db,
  userId: string,
  input: CustomMasterInput,
): { id: string; name: string } {
  const name = input.name.trim();
  if (!name || name.length > 12) {
  throw new Error("名字要在 1 到 12 个字之间");
  }
  if (!input.brief || input.brief.trim().length < 5) {
  throw new Error("描述太短了，多给几句关于 ta 的线索");
  }

  // 结构兜底：漏掉的关系阶段补默认三阶段；样例对话缺省给一条空位避免提示词层空洞
  const persona = normalizeCard(input.persona);
  const relationshipStages = normalizeRelationshipStages(persona.relationship_stages);

  const id = randomUUID();
  db.insert(masters)
  .values({
  id,
  ownerId: userId,
  name,
  personaJson: JSON.stringify({ ...persona, relationship_stages: relationshipStages }),
  avatar: normalizeAvatarName(input.avatar),
  isOfficial: 0,
  createdAt: Date.now(),
  })
  .run();

  return { id, name };
}

export interface ImportMasterOptions {
  avatar?: string | null;
}

export interface CardFields {
  name: string;
  persona: PersonaJson;
  avatar?: string | null;
}

/**
 * 新增会长 · 手填卡字段（与「指名邀请」同一条落库路径）。
 * 与导入卡的区别：没有 brief、名字放宽到 40 字，不建世界书。
 */
export function createMasterFromFields(
  db: Db,
  userId: string,
  input: CardFields,
): { id: string; name: string } {
  const name = input.name.trim().slice(0, 40);
  if (!name) throw new Error("请先给这位会长起个名字");

  const persona = normalizeCard(input.persona);
  const relationshipStages = normalizeRelationshipStages(persona.relationship_stages);

  const id = randomUUID();
  db.insert(masters)
    .values({
      id,
      ownerId: userId,
      name,
      personaJson: JSON.stringify({ ...persona, relationship_stages: relationshipStages }),
      avatar: normalizeAvatarName(input.avatar),
      isOfficial: 0,
      createdAt: Date.now(),
    })
    .run();

  return { id, name };
}

/**
 * P5 从导入的角色卡创建一位自定义会长（owner_id = userId），
 * 并把卡片内嵌的 character_book 落成该会长的世界书（角色书）。
 * 与「指名邀请」不同：导入不再要求 brief，名字放宽到 40 字。
 */
export function createMasterFromCard(
  db: Db,
  userId: string,
  card: ImportedCard,
  opts: ImportMasterOptions = {},
): { id: string; name: string; worldBookEntries: number } {
  const name = card.name.trim().slice(0, 40);
  if (!name) throw new Error("角色卡缺少可用名字");

  const persona = normalizeCard(card.persona);
  const relationshipStages = normalizeRelationshipStages(persona.relationship_stages);

  const id = randomUUID();
  db.insert(masters)
  .values({
  id,
  ownerId: userId,
  name,
  personaJson: JSON.stringify({ ...persona, relationship_stages: relationshipStages }),
  avatar: normalizeAvatarName(opts.avatar),
  isOfficial: 0,
  createdAt: Date.now(),
  })
  .run();

  let worldBookEntries = 0;
  if (card.characterBook) {
  const r = replaceMasterBookFromCharacterBook(db, userId, id, name, card.characterBook);
  worldBookEntries = r.entries;
  }

  return { id, name, worldBookEntries };
}

/**
 * 设置 / 清除会长头像（酒馆式：一个角色一张图）。
 * 官方与自定义会长都可设；文件真实存在性由调用方（上传/导入接口）保证。
 */
export function setMasterAvatar(
  db: Db,
  userId: string,
  masterId: string,
  avatar: string | null,
): boolean {
  const row = db
    .select({ id: masters.id })
    .from(masters)
    .where(and(eq(masters.id, masterId), isNull(masters.archivedAt)))
    .get();
  if (!row) return false;
  const res = db
    .update(masters)
    .set({ avatar: normalizeAvatarName(avatar) })
    .where(eq(masters.id, masterId))
    .run();
  return res.changes > 0;
}

/**
 * P1 归档（软删除）一位自定义会长。
 * - 官方会长不可删除（isOfficial=1）；
 * - 只能删自己指名的（owner_id = userId）；
 * - 当前在任的会长不可直接删（先换一位）——避免把 save.active_master_id 指空；
 * - 归档时清掉它的全部对话数据（任务模式 + 酒馆模式的消息、会话、记忆）与好感；
 * - master 行本身只置 archived_at：master_history / 结算卡仍能解析名字，历史账目不丢。
 */
export function archiveMaster(
  db: Db,
  userId: string,
  masterId: string,
  now = Date.now(),
): { ok: true } {
  const master = db.select().from(masters).where(eq(masters.id, masterId)).get();
  if (!master) throw new Error("这位会长不存在");
  if (master.isOfficial === 1) throw new Error("官方会长不能删除");
  if (master.ownerId !== userId) throw new Error("只能删除自己请来的会长");
  if (master.archivedAt != null) return { ok: true };

  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (save?.activeMasterId === masterId) {
    throw new Error("当前在任的会长不能删除，先换一位执掌协会");
  }

  db.update(masters)
  .set({ archivedAt: now })
  .where(eq(masters.id, masterId))
  .run();
  // 归档即拆掉它的世界书分配；只属于它、没别的会长在用的书册一并删掉（全局书不动）
  removeMasterBooks(db, userId, masterId);
  // P12：清除该会长的全部对话数据——任务模式与酒馆模式的消息、会话，
  // 会长级永久记忆与各对话私有记忆（只清 chat 会话是漏的）。
  const purged = purgeMasterChatData(db, userId, masterId);
  // 消息配图（以消息 id 命名的 data/scenes/<id>.png）与头像文件一并删掉
  for (const messageId of purged.messageIds) {
    deleteAsset("scene", `${messageId}.png`);
  }
  deleteAsset("avatar", master.avatar);
  // 好感度跟着会长一起消失，避免之后重建同名会长继承旧数值
  db.delete(masterAffinity)
    .where(and(eq(masterAffinity.userId, userId), eq(masterAffinity.masterId, masterId)))
    .run();
  // 若它正被指定为「聊天会长」，清掉指向（回落到任务会长）
  if (save?.chatMasterId === masterId) {
    db.update(saves).set({ chatMasterId: null }).where(eq(saves.id, save.id)).run();
  }
  return { ok: true };
}

/**
 * 当前会长本次任期起点（master_history 里 master_id=activeMasterId 且未结束）。
 * 聊天模式用它把历史范围限定在「当前会长执掌以来」——换人即开新会话（酒馆语义）。
 * 无记录时返回 0（不设限，保证老数据仍能读到）。
 */
export function activeTenureStartedAt(db: Db, userId: string): number {
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  if (!save?.activeMasterId) return 0;
  const row = db
  .select({ startedAt: masterHistory.startedAt })
  .from(masterHistory)
  .where(
  and(
  eq(masterHistory.saveId, save.id),
  eq(masterHistory.masterId, save.activeMasterId),
  isNull(masterHistory.endedAt),
  ),
  )
  .orderBy(desc(masterHistory.startedAt))
  .get();
  return row?.startedAt ?? 0;
}
