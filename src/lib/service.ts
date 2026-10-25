import { and, desc, eq, isNull, like, lt, or } from "drizzle-orm";

import { getDb } from "@/server/db";
import { LOCAL_USER_ID } from "@/server/db/seed";
import { appSettings, chatLog, character, masters, quests, saves } from "@/server/db/schema";
import {
  archiveMaster,
  createMasterFromCard,
  createMasterFromFields,
  getActiveMasterId,
  getChatMasterId,
  getChatMasterSetting,
  getSaveState,
  intimacyLabel,
  isOnboarded,
  listSelectableMasters,
  markOnboarded,
  setChatMaster,
  setMasterAvatar,
  setMasterSprite,
  switchMaster,
} from "@/server/masters";
import { parseCard } from "@/server/cards";
import { cardIntroText } from "@/weblib/labels";
import type { PetDescriptor } from "@/weblib/petCatalog";
import { sanitizeSprite, autoMapSpriteForMaster } from "@/server/petSprite";
import { parseCardBytes, toImportedCard, type ImportedCard } from "@/server/cardImport";
import { translationPreview } from "@/server/translate";
import { forgeCardFromFields } from "@/server/personaForge";
import { saveAsset, assetUrl, sceneFilename, isPng, saveScene, deleteAsset } from "@/server/assets";
import {
  chatGreetingOptions,
  cycleChatGreeting,
  ensureChatGreeting,
  runChatConversation,
  runConversation,
  type ConversationStreamEvent,
} from "@/server/llm/conversation";
import { markPending, clearPending, pendingKey, isPending } from "@/server/llm/pending";
import {
  ensureActiveSession,
  getSession,
  listSessions,
  createSession,
  renameSession,
  deleteSession,
  setSessionScene,
} from "@/server/chatSessions";
import { chatWindowStart, hasRecordsBefore, queryRecords, type ChatMode, type RecordItem } from "@/server/records";
import { getSceneJob, startSceneJob, cancelSceneJob, isSceneGenerating } from "@/server/image/jobs";
import { getImageConfig, setImageSettings, type ImageConfig } from "@/server/image/config";
import { settlementsToCsv, settlementsToMarkdown } from "@/server/export";
import { buildScenePrompt, generateImage } from "@/server/image/generate";
import { randomUUID } from "@/server/util/id";
import { getLlmConfigState, resolveLlmConfig, setLlmSettings, LLM_PROVIDERS, type LlmConfigState, type LlmProvider } from "@/server/modelConfig";
import { getSecret, setSecret } from "@/server/secure";
import { chatComplete, type LlmConfig } from "@/server/llm/client";
import { getRpSettings, setRpEnabled } from "@/server/rp";
import { getUserPersona, setUserPersona } from "@/server/userPersona";
import { getCharacterSummary, getMonthSummary, getSettlementsSince } from "@/server/character";
import { allRanks, rankBadgeInfo, levelFromXp, rankFromLevel } from "@/server/engine/leveling";
import { listSkills, purchaseSkill } from "@/server/skills";
import { listAchievements } from "@/server/achievements";
import { getWeeklyBossState } from "@/server/weeklyBoss";
import { repeatQuest as repeatQuestRow } from "@/server/quests";
import { getItemStock, giftItem as giftItemRow, itemUnlockState, purchaseItem, shopCatalog } from "@/server/shop";
import { shopDiscountFor } from "@/server/dailyEvent";
import {
  appendBookEntries,
  assignBook,
  createBook,
  deleteBook,
  deleteBookEntry,
  estimateTokens,
  listBookEntries,
  listBooksForMaster,
  listMastersForBook,
  listWorldBooks,
  parseLorebook,
  renameBook,
  unassignBook,
  upsertBookEntry,
  type WorldBookInsert,
} from "@/server/worldbook";
import {
  addMemory,
  deleteMemory,
  deleteMemories,
  isMemoryCategory,
  listMemories,
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABELS,
  setMemoryEnabled,
  updateMemory,
} from "@/server/memory";
import { startOfMonth, startOfToday } from "@/server/util/time";

export function ctx() {
  return { db: getDb(), userId: LOCAL_USER_ID };
}

function parseSprite(s: string | null): PetDescriptor | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as PetDescriptor;
  } catch {
    return null;
  }
}

// ============================================================ onboarding

export function onboardingState() {
  const { db, userId } = ctx();
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  let masterName: string | null = null;
  if (save?.activeMasterId) {
    masterName = db.select({ name: masters.name }).from(masters).where(eq(masters.id, save.activeMasterId)).get()?.name ?? null;
  }
  return {
    onboarded: isOnboarded(db, userId),
    activeMasterId: save?.activeMasterId ?? null,
    masterName,
    needsGate: !isOnboarded(db, userId),
  };
}

export function completeOnboarding(): boolean {
  const { db, userId } = ctx();
  return markOnboarded(db, userId);
}

// ============================================================ masters

export interface MasterItem {
  id: string;
  name: string;
  avatar: string | null;
  sprite: PetDescriptor | null;
  selfIntro: string;
  backstory: string;
  tags: string[];
  isOfficial: boolean;
  isCustom: boolean;
}

export function mastersData() {
  const { db, userId } = ctx();
  const state = getSaveState(db, userId);
  return {
    masters: listSelectableMasters(db, userId).map((m): MasterItem => {
      const selfIntro = cardIntroText(m.persona, 120);
      const backstory = cardIntroText(
        {
          self_intro: m.persona.backstory?.trim() || undefined,
          description: m.persona.description,
          first_mes: m.persona.first_mes,
          tags: m.persona.tags,
        },
        160,
      );
      return {
        id: m.id,
        name: m.name,
        avatar: assetUrl("avatar", m.avatar),
        sprite: parseSprite(m.sprite),
        selfIntro,
        backstory: backstory === selfIntro ? "" : backstory,
        tags: m.persona.tags ?? [],
        isOfficial: m.isOfficial,
        isCustom: m.isCustom,
      };
    }),
    activeMasterId: state?.activeMasterId ?? null,
    intimacyLabel: state?.intimacyLabel ?? "初识",
  };
}

export async function activateMaster(masterId: string) {
  const { db, userId } = ctx();
  const result = await switchMaster(db, userId, masterId);
  const state = getSaveState(db, userId);
  return { ...result, intimacyLabel: state?.intimacyLabel ?? "初识" };
}

export async function forgeMaster(input: {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  firstMes?: string;
  tags?: string;
}) {
  const { db } = ctx();
  return forgeCardFromFields(resolveLlmConfig(db), input);
}

export function createMasterByFields(input: {
  card: {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    firstMes?: string;
    greetings?: string;
    tags?: string;
    avatar?: string | null;
  };
  persona?: Record<string, unknown> | null;
}) {
  const { db, userId } = ctx();
  const c = input.card;
  const str = (v?: string) => (v ?? "").trim();
  const name = str(c.name);
  if (!name) throw new Error("请先给这位会长起个名字");
  if (name.length > 40) throw new Error("名字最多 40 个字");
  const description = str(c.description);
  const firstMes = str(c.firstMes);
  if (!description && !firstMes) throw new Error("至少写一段描述，或一句开场白——不然会长不知道该怎么说话");
  if (description.length > 2000) throw new Error("描述太长了");
  const splitList = (v?: string) =>
    str(v)
      .split(/[\n,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const ai = (input.persona ?? {}) as Record<string, unknown>;
  const greetingList = Array.isArray(ai.alternate_greetings) ? (ai.alternate_greetings as string[]) : splitList(c.greetings).slice(0, 4);
  const persona = {
    ...ai,
    self_intro: description.slice(0, 120) || (ai.self_intro as string) || undefined,
    description: description || undefined,
    personality: splitList(c.personality).slice(0, 12),
    scenario: str(c.scenario) || undefined,
    first_mes: firstMes || undefined,
    alternate_greetings: greetingList,
    tags: splitList(c.tags).slice(0, 8),
    backstory: ai.backstory as string | undefined,
  };
  return createMasterFromFields(db, userId, { name, persona, avatar: str(c.avatar ?? undefined) || null });
}

export function previewImportedCard(bytes: Uint8Array, filename: string) {
  const card = toImportedCard(parseCardBytes(bytes, filename));
  const pv = translationPreview(card);
  const avatarFile = isPng(bytes) ? saveAsset("avatar", bytes, filename || "card.png", "image/png") : null;
  return { card, ...pv, avatarFile, name: card.name, spec: card.spec };
}

export function commitImportedCard(card: ImportedCard, translate: boolean) {
  const { db, userId } = ctx();
  let out = card;
  let translated = { fields: 0, entries: 0 };
  if (translate) {
    // 同步路径（导入页用后台 job 时不会走这里）
    throw new Error("请使用后台翻译任务");
  }
  return { ...createMasterFromCard(db, userId, out), translated };
}

export function deleteMaster(masterId: string) {
  const { db, userId } = ctx();
  archiveMaster(db, userId, masterId);
}

export function saveMasterAvatar(masterId: string, file: string | null) {
  const { db, userId } = ctx();
  return setMasterAvatar(db, userId, masterId, file);
}

export function uploadAvatar(bytes: Uint8Array, filename: string, mime?: string) {
  return saveAsset("avatar", bytes, filename, mime);
}

export function uploadBackground(bytes: Uint8Array, filename: string, mime?: string) {
  return saveAsset("background", bytes, filename, mime);
}

export function saveMasterSprite(masterId: string, sprite: Partial<PetDescriptor>) {
  const { db, userId } = ctx();
  const clean = sanitizeSprite(sprite);
  setMasterSprite(db, userId, masterId, JSON.stringify(clean));
  return clean;
}

export async function autoSprite(masterId: string) {
  const { db, userId } = ctx();
  return autoMapSpriteForMaster(db, userId, masterId);
}

export function masterCard(masterId: string) {
  const { db, userId } = ctx();
  const m = db.select().from(masters).where(and(eq(masters.id, masterId), or(eq(masters.ownerId, userId), isNull(masters.ownerId)))).get();
  if (!m) throw new Error("会长不存在");
  const card = parseCard(m.personaJson);
  return {
    masterId,
    card: {
      first_mes: card.first_mes ?? "",
      alternate_greetings: card.alternate_greetings ?? [],
      description: card.description ?? "",
      scenario: card.scenario ?? "",
      tags: card.tags ?? [],
    },
  };
}

export function updateMasterCard(masterId: string, patch: {
  first_mes?: string;
  alternate_greetings?: string[];
  description?: string;
  scenario?: string;
  tags?: string[];
}) {
  const { db, userId } = ctx();
  const m = db.select().from(masters).where(and(eq(masters.id, masterId), or(eq(masters.ownerId, userId), isNull(masters.ownerId)))).get();
  if (!m) throw new Error("会长不存在");
  const card = parseCard(m.personaJson);
  if (patch.first_mes !== undefined) card.first_mes = patch.first_mes.trim() || undefined;
  if (patch.alternate_greetings !== undefined) {
    card.alternate_greetings = patch.alternate_greetings.map((g) => g.trim()).filter(Boolean).slice(0, 8);
  }
  if (patch.description !== undefined) card.description = patch.description.trim() || undefined;
  if (patch.scenario !== undefined) card.scenario = patch.scenario.trim() || undefined;
  if (patch.tags !== undefined) card.tags = patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 12);
  db.update(masters).set({ personaJson: JSON.stringify(card) }).where(eq(masters.id, m.id)).run();
}

// ============================================================ chat

export interface ChatItem {
  type: "message" | "settlement";
  message?: {
    id: string;
    role: "user" | "master";
    content: string;
    sender: string;
    createdAt: number;
    image?: string | null;
    generating?: boolean;
    generatingSince?: number;
  };
  settlement?: unknown;
}

export function chatScreenData(mode: ChatMode, requestedSessionId?: string | null, before?: number | null) {
  const { db, userId } = ctx();
  const save = db.select().from(saves).where(eq(saves.userId, userId)).get();
  const currentMasterId = mode === "chat" ? getChatMasterId(db, userId) : (save?.activeMasterId ?? null);
  let masterName = "会长";
  let masterAvatar: string | null = null;
  let masterSprite: PetDescriptor | null = null;
  if (currentMasterId) {
    const m = db.select().from(masters).where(eq(masters.id, currentMasterId)).get();
    if (m) {
      masterName = m.name;
      masterAvatar = assetUrl("avatar", m.avatar);
      masterSprite = parseSprite(m.sprite);
    }
  }

  let sessionId: string | null = null;
  let sessions: ReturnType<typeof listSessions> = [];
  if (mode === "chat" && currentMasterId) {
    const wanted = requestedSessionId ? getSession(db, userId, requestedSessionId) : null;
    sessionId = wanted && wanted.masterId === currentMasterId ? wanted.id : ensureActiveSession(db, userId, currentMasterId);
    if (sessionId) ensureChatGreeting(db, userId, sessionId);
    sessions = listSessions(db, userId, currentMasterId);
  }

  const windowStart = chatWindowStart();
  const { items, hasMore, nextBefore } = queryRecords(db, userId, {
    ...(mode === "chat" ? { before: before ?? null, limit: 200 } : { since: windowStart, limit: 300 }),
    mode,
    sessionId,
    masterId: mode === "quest" ? (save?.activeMasterId ?? null) : null,
  });
  items.reverse();

  const messages = items.filter((it): it is Extract<RecordItem, { type: "message" }> => it.type === "message");
  const settlements = items.filter((it): it is Extract<RecordItem, { type: "settlement" }> => it.type === "settlement");
  const session = sessionId ? getSession(db, userId, sessionId) : null;

  return {
    mode,
    masterName,
    imageEnabled: getImageConfig(db).enabled,
    masterAvatar,
    masterSprite,
    background: assetUrl("background", session?.scene),
    activeMasterId: currentMasterId,
    windowStart,
    hasEarlier: mode === "chat" ? hasMore : hasRecordsBefore(db, userId, windowStart, mode, sessionId, save?.activeMasterId ?? null),
    nextBefore: mode === "chat" ? nextBefore : null,
    messages: messages.map((m) => {
      const job = getSceneJob(m.id, db);
      const generating = !!job && (job.status === "queued" || job.status === "running");
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        sender: m.sender,
        createdAt: m.createdAt,
        image: assetUrl("scene", sceneFilename(m.id)),
        generating,
        generatingSince: generating ? job!.startedAt : undefined,
      };
    }),
    settlements: settlements.map((s) => s.settlement),
    sessionId,
    sessions,
    greeting: mode === "chat" && sessionId ? chatGreetingOptions(db, userId, sessionId) : undefined,
    pending: isPending(pendingKey(userId, mode, mode === "chat" ? sessionId : (save?.activeMasterId ?? null)), db),
  };
}

export interface SendChatResult {
  mode: ChatMode;
  reply: string;
  userMessageId: string;
  masterMessageId: string;
  sessionId?: string | null;
  toolSummaries?: unknown;
  stateChanged?: boolean;
  settlementNotices?: string[];
  reminderNotices?: string[];
  settlements?: unknown;
  ceremony?: unknown;
}

export async function sendChat(input: {
  message: string;
  mode: ChatMode;
  sessionId?: string | null;
  onEvent?: (e: ConversationStreamEvent) => void;
  signal?: AbortSignal;
}): Promise<SendChatResult> {
  const { db, userId } = ctx();
  const mode = input.mode;
  const message = input.message.trim();
  if (!message) throw new Error("消息不能为空");

  let chatSessionId: string | null = null;
  if (mode === "chat") {
    const masterId = getChatMasterId(db, userId);
    let sid = input.sessionId ?? undefined;
    if (sid) {
      const s = getSession(db, userId, sid);
      if (!s || s.masterId !== masterId) sid = undefined;
    }
    if (!sid && masterId) sid = ensureActiveSession(db, userId, masterId);
    if (!sid) throw new Error("还没有会长，先去选一位");
    chatSessionId = sid;
  }

  const pendingScope = mode === "chat" ? chatSessionId : getActiveMasterId(db, userId);
  const pendingK = pendingKey(userId, mode, pendingScope);
  markPending(pendingK, db);
  try {
    if (mode === "chat") {
      const result = await runChatConversation(db, userId, message, chatSessionId!, {
        onEvent: input.onEvent,
        signal: input.signal,
      });
      return {
        mode,
        sessionId: chatSessionId,
        reply: result.replyText,
        userMessageId: result.userMessageId,
        masterMessageId: result.masterMessageId,
      };
    }
    const result = await runConversation(db, userId, message, {
      onEvent: input.onEvent,
      signal: input.signal,
    });
    return {
      mode,
      reply: result.replyText,
      userMessageId: result.userMessageId,
      masterMessageId: result.masterMessageId,
      toolSummaries: result.toolSummaries,
      stateChanged: result.stateChanged,
      settlementNotices: result.settlementNotices,
      reminderNotices: result.reminderNotices,
      settlements: result.settlements,
      ceremony: result.ceremony ?? null,
    };
  } finally {
    clearPending(pendingK, db);
  }
}

export function cycleGreeting(sessionId: string) {
  const { db, userId } = ctx();
  const r = cycleChatGreeting(db, userId, sessionId);
  if (!r.ok) throw new Error(r.reason ?? "换不了开场白");
  return r;
}

export function sessionAction(action: "create" | "rename" | "delete" | "setBackground", input: { sessionId?: string; title?: string; scene?: string | null }) {
  const { db, userId } = ctx();
  const masterId = getActiveMasterId(db, userId);
  if (!masterId) throw new Error("还没有会长");
  if (action === "create") {
    const id = createSession(db, userId, masterId, input.title ?? "新的对话");
    return { sessionId: id };
  }
  if (!input.sessionId) throw new Error("缺少 sessionId");
  const s = getSession(db, userId, input.sessionId);
  if (!s || s.masterId !== masterId) throw new Error("会话不存在");
  if (action === "rename") {
    renameSession(db, userId, input.sessionId, input.title ?? "");
    return { sessionId: input.sessionId };
  }
  if (action === "setBackground") {
    setSessionScene(db, userId, input.sessionId, input.scene ?? null);
    return { sessionId: input.sessionId };
  }
  const remaining = listSessions(db, userId, masterId).filter((x) => x.id !== input.sessionId);
  deleteSession(db, userId, input.sessionId);
  const nextId = remaining[0]?.id ?? createSession(db, userId, masterId, "新的对话");
  return { nextSessionId: nextId };
}

export function deleteChatMessage(id: string) {
  const { db, userId } = ctx();
  db.delete(chatLog).where(and(eq(chatLog.id, id), eq(chatLog.userId, userId))).run();
  const scene = sceneFilename(id);
  if (scene) deleteAsset("scene", scene);
}

export function startScene(messageId: string, prompt?: string) {
  const { db, userId } = ctx();
  const cfg = getImageConfig(db);
  if (!cfg.enabled) throw new Error("生图还没开启。到「设置 → 生图」打开。");
  const msg = db.select().from(chatLog).where(and(eq(chatLog.id, messageId), eq(chatLog.userId, userId))).get();
  if (!msg) throw new Error("找不到这条消息");
  return startSceneJob(db, userId, { id: msg.id, content: msg.content, masterId: msg.masterId, sessionId: msg.sessionId }, prompt);
}

export function sceneStatus(messageId: string) {
  const { db } = ctx();
  const filename = sceneFilename(messageId);
  if (filename) return { status: "done" as const, url: assetUrl("scene", filename) };
  const job = getSceneJob(messageId, db);
  if (job?.status === "error") return { status: "error" as const, error: job.error };
  if (job && (job.status === "queued" || job.status === "running")) return { status: job.status, startedAt: job.startedAt };
  return { status: "idle" as const };
}

export function cancelScene(messageId: string) {
  const { db } = ctx();
  return cancelSceneJob(messageId, db);
}

// ============================================================ quests

export function questBoard() {
  const { db, userId } = ctx();
  const rows = db.select().from(quests).where(eq(quests.userId, userId)).orderBy(desc(quests.createdAt)).all();
  const monthStart = startOfMonth();
  const inBoard = rows.filter((r) => r.status !== "completed" || (r.completedAt ?? 0) >= monthStart);
  const olderCompletedCount = rows.filter((r) => r.status === "completed" && (r.completedAt ?? 0) < monthStart).length;
  const mainlineRows = rows.filter((r) => r.type === "mainline");
  const mainlineIds = new Set(mainlineRows.map((r) => r.id));
  const mainlines = mainlineRows.map((m) => ({
    ...m,
    milestones: rows.filter((c) => c.parentQuestId === m.id).sort((a, b) => a.createdAt - b.createdAt),
  }));
  const orphans = inBoard.filter((r) => r.type === "mainline_milestone" && !mainlineIds.has(r.parentQuestId ?? ""));
  const plain = inBoard.filter((r) => r.type !== "mainline" && r.type !== "mainline_milestone");
  return { quests: [...plain, ...orphans], mainlines, olderCompletedCount };
}

export function questArchive(input: { before?: number | null; q?: string; limit?: number }) {
  const { db, userId } = ctx();
  const size = Math.min(Math.floor(input.limit ?? 50), 100);
  const conditions = [eq(quests.userId, userId), eq(quests.status, "completed")];
  if (input.before && input.before > 0) conditions.push(lt(quests.completedAt, input.before));
  if (input.q?.trim()) conditions.push(likeTitle(input.q.trim()));
  const rows = db.select().from(quests).where(and(...conditions)).orderBy(desc(quests.completedAt)).limit(size + 1).all();
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  return { quests: page, hasMore, nextBefore: page.length ? page[page.length - 1].completedAt : null };
}

function likeTitle(q: string) {
  return like(quests.title, `%${q}%`);
}

export function repeatQuest(questId: string) {
  const { db, userId } = ctx();
  const r = repeatQuestRow(db, userId, questId);
  if (!r.ok) throw new Error(r.error);
  return r.quest;
}

// ============================================================ character

export function characterPanel() {
  const { db, userId } = ctx();
  const summary = getCharacterSummary(db, userId);
  const skills = listSkills(db, userId);
  const dex = listAchievements(db, userId);
  const weeklyBoss = getWeeklyBossState(db, userId);
  return {
    ...summary,
    rankBadge: rankBadgeInfo(summary.totalLevel),
    ranks: allRanks(),
    monthSummary: getMonthSummary(db, userId),
    skillSummary: { owned: skills.skills.filter((s) => s.owned).length, total: skills.skills.length },
    achievements: dex.achievements,
    achievementSummary: { owned: dex.owned, total: dex.total },
    weeklyBoss: {
      week: weeklyBoss.week,
      name: weeklyBoss.boss.name,
      desc: weeklyBoss.boss.desc,
      progress: weeklyBoss.progress,
      target: weeklyBoss.boss.target,
      claimed: weeklyBoss.claimed,
      reward: weeklyBoss.reward,
    },
  };
}

export function bill(input: { before?: number | null; limit?: number; kinds?: string[] }) {
  const { db, userId } = ctx();
  const { items, hasMore, nextBefore } = queryRecords(db, userId, {
    kind: "settlement",
    before: input.before ?? null,
    limit: input.limit ?? 30,
    settlementKinds: input.kinds?.length ? input.kinds : undefined,
  });
  return {
    settlements: items.map((it) => (it as Extract<RecordItem, { type: "settlement" }>).settlement),
    hasMore,
    nextBefore,
  };
}

export function exportBills(format: "csv" | "md") {
  const { db, userId } = ctx();
  const { items } = queryRecords(db, userId, { kind: "settlement", limit: 5000 });
  const records = items.map((it) => (it as Extract<RecordItem, { type: "settlement" }>).settlement);
  return format === "csv" ? settlementsToCsv(records) : settlementsToMarkdown(records);
}

// ============================================================ shop / skills

export function shopData() {
  const { db, userId } = ctx();
  const char = db.select({ gold: character.gold, totalXp: character.totalXp }).from(character).where(eq(character.userId, userId)).get();
  const save = getSaveState(db, userId);
  const level = levelFromXp(char?.totalXp ?? 0);
  const rank = rankFromLevel(level);
  return {
    gold: char?.gold ?? 0,
    level,
    rank,
    intimacy: save ? { stage: save.intimacyStage, label: save.intimacyLabel, points: save.intimacyPoints } : null,
    items: shopCatalog().map((item) => {
      const shelf = itemUnlockState(level, rank, item);
      const discount = shopDiscountFor(db, userId, item);
      return {
        ...item,
        count: getItemStock(db, userId, item.key)?.count ?? 0,
        unlocked: shelf.unlocked,
        unlockHint: shelf.hint,
        discount: discount ? { ratio: discount.ratio, priceAfter: discount.priceAfter } : null,
      };
    }),
  };
}

export function shopBuy(itemKey: string) {
  const { db, userId } = ctx();
  const r = purchaseItem(db, userId, itemKey);
  if (!r.ok) throw new Error(r.error);
  return r.receipt;
}

export function shopGift(itemKey: string) {
  const { db, userId } = ctx();
  const r = giftItemRow(db, userId, itemKey);
  if (!r.ok) throw new Error(r.error);
  return r.receipt;
}

export function skillsData() {
  const { db, userId } = ctx();
  return listSkills(db, userId);
}

export function unlockSkill(skillKey: string) {
  const { db, userId } = ctx();
  const r = purchaseSkill(db, userId, skillKey);
  if (!r.ok) throw new Error(r.error);
  return r;
}

// ============================================================ worldbook

export function worldBooks() {
  const { db, userId } = ctx();
  return listWorldBooks(db, userId);
}

export function worldBookDetail(bookId: string) {
  const { db, userId } = ctx();
  const entries = listBookEntries(db, userId, bookId);
  const usedByIds = listMastersForBook(db, userId, bookId);
  const all = db.select({ id: masters.id, name: masters.name }).from(masters).all();
  const nameMap = new Map(all.map((r) => [r.id, r.name]));
  const constantTokens = entries.filter((e) => e.enabled && e.constant).reduce((sum, e) => sum + estimateTokens(e.content), 0);
  const totalTokens = entries.filter((e) => e.enabled).reduce((sum, e) => sum + estimateTokens(e.content), 0);
  return {
    bookId,
    entries,
    usedBy: usedByIds.map((id) => ({ id, name: nameMap.get(id) ?? "?" })),
    stats: { constantTokens, totalTokens, count: entries.length },
  };
}

export function worldBookAction(body: Record<string, unknown>) {
  const { db, userId } = ctx();
  const action = String(body.action ?? "");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (action) {
    case "createBook":
      return { id: createBook(db, userId, str(body.name) || "新世界书") };
    case "renameBook":
      renameBook(db, userId, str(body.bookId), str(body.name));
      return { ok: true };
    case "deleteBook":
      if (!deleteBook(db, userId, str(body.bookId))) throw new Error("世界书不存在");
      return { ok: true };
    case "assign":
      assignBook(db, userId, str(body.masterId), str(body.bookId));
      return { ok: true };
    case "unassign":
      unassignBook(db, userId, str(body.masterId), str(body.bookId));
      return { ok: true };
    case "cloneFromMaster": {
      const from = str(body.fromMasterId);
      const to = str(body.masterId);
      const sourceBooks = listBooksForMaster(db, userId, from);
      if (sourceBooks.length === 0) throw new Error("来源会长没有世界书");
      let copied = 0;
      for (const b of sourceBooks) {
        const srcEntries = listBookEntries(db, userId, b.id);
        const newBookId = createBook(db, userId, `${b.name}（副本）`);
        appendBookEntries(
          db,
          userId,
          newBookId,
          srcEntries.map((e) => ({
            keys: e.keys,
            secondaryKeys: e.secondaryKeys,
            content: e.content,
            enabled: e.enabled,
            constant: e.constant,
            selective: e.selective,
            insertionOrder: e.insertionOrder,
            position: e.position,
            depth: e.depth,
            role: e.role,
            priority: e.priority,
            caseSensitive: e.caseSensitive,
            useRegex: e.useRegex,
            scanDepth: e.scanDepth,
            extensions: e.extensions,
          })),
        );
        assignBook(db, userId, to, newBookId);
        copied++;
      }
      return { ok: true, copied };
    }
    case "upsertEntry": {
      const entry = body.entry as WorldBookInsert & { id?: string };
      if (!entry || !entry.content?.trim()) throw new Error("条目内容不能为空");
      return { id: upsertBookEntry(db, userId, str(body.bookId), { ...entry, keys: Array.isArray(entry.keys) ? entry.keys : [] }) };
    }
    case "deleteEntry":
      deleteBookEntry(db, userId, str(body.id));
      return { ok: true };
    case "import": {
      const json = str(body.json);
      if (!json.trim()) throw new Error("缺少世界书 JSON");
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        throw new Error("不是合法 JSON");
      }
      const entries = parseLorebook(raw);
      if (entries.length === 0) throw new Error("没解析出任何条目");
      appendBookEntries(db, userId, str(body.bookId), entries);
      return { ok: true, imported: entries.length };
    }
    default:
      throw new Error(`未知 action：${action}`);
  }
}

// ============================================================ memory

export function memoryData(masterId: string, sessionId?: string | null) {
  const { db, userId } = ctx();
  return {
    memories: listMemories(db, userId, masterId, sessionId ?? null),
    categories: MEMORY_CATEGORIES.map((c) => ({ id: c, label: MEMORY_CATEGORY_LABELS[c] ?? c })),
    sessions: listSessions(db, userId, masterId).map((s) => ({ id: s.id, title: s.title, messageCount: s.messageCount })),
  };
}

export function memoryAction(body: Record<string, unknown>) {
  const { db, userId } = ctx();
  const action = String(body.action ?? "");
  const id = typeof body.id === "string" ? body.id : "";
  if (action === "deleteMany") return { deleted: deleteMemories(db, userId, Array.isArray(body.ids) ? (body.ids as string[]) : []) };
  if (action === "add") {
    if (!isMemoryCategory(body.category)) throw new Error("未知的记忆类别");
    const newId = addMemory(db, userId, (body.masterId as string) ?? null, body.category, String(body.content ?? ""), (body.sessionId as string) ?? null);
    if (!newId) throw new Error("内容为空，或这条记忆已经记过了");
    return { id: newId };
  }
  if (!id) throw new Error("缺少 id");
  if (action === "update") {
    if (!updateMemory(db, userId, id, String(body.content ?? ""))) throw new Error("内容为空或条目不存在");
    return { ok: true };
  }
  if (action === "toggle") {
    if (!setMemoryEnabled(db, userId, id, body.enabled !== false)) throw new Error("条目不存在");
    return { ok: true };
  }
  if (action === "delete") {
    if (!deleteMemory(db, userId, id)) throw new Error("条目不存在");
    return { ok: true };
  }
  throw new Error(`未知 action：${action}`);
}

// ============================================================ records

export function records(input: { before?: number | null; limit?: number; q?: string; kind?: "all" | "chat" | "settlement" }) {
  const { db, userId } = ctx();
  return queryRecords(db, userId, {
    before: input.before ?? null,
    limit: input.limit ?? 40,
    q: input.q?.trim() || undefined,
    kind: input.kind ?? "all",
  });
}

// ============================================================ settings

export interface SettingsState extends LlmConfigState {
  rp: { enabled: boolean };
  image: ImageConfig;
  chatMasterId: string | null;
  chatMasterEffectiveId: string | null;
  activeMasterId: string | null;
  masters: { id: string; name: string }[];
}

export function settingsState(): SettingsState {
  const { db, userId } = ctx();
  return {
    ...getLlmConfigState(db),
    rp: getRpSettings(db),
    image: getImageConfig(db),
    chatMasterId: getChatMasterSetting(db, userId),
    chatMasterEffectiveId: getChatMasterId(db, userId),
    activeMasterId: getActiveMasterId(db, userId),
    masters: listSelectableMasters(db, userId).map((m) => ({ id: m.id, name: m.name })),
  };
}

export async function saveLlm(patch: {
  provider?: LlmProvider;
  model?: string;
  judgeModel?: string;
  baseUrl?: string;
  apiKey?: string;
}) {
  const { db } = ctx();
  const provider = patch.provider;
  if (patch.apiKey !== undefined && provider) {
    await setSecret(provider, patch.apiKey);
  }
  setLlmSettings(db, {
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.judgeModel !== undefined ? { judgeModel: patch.judgeModel } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
  });
  return getLlmConfigState(db);
}

export async function testLlm(input: { provider?: LlmProvider; baseUrl?: string; model?: string; apiKey?: string }) {
  const { db } = ctx();
  const stored = resolveLlmConfig(db);
  const provider = input.provider ?? (stored.provider as LlmProvider);
  const baseUrl = input.baseUrl?.trim() || stored.baseUrl;
  const key = input.apiKey?.trim() || (provider === stored.provider ? stored.apiKey : getSecret(provider)) || (provider === "local" ? "sk-local" : "");
  const model = input.model?.trim() || stored.model;
  if (!model) throw new Error("请先填模型名（可访问 {接口地址}/models 查看你的服务暴露的名字）。");
  if (!key) throw new Error("还没填 API Key");
  const cfg: LlmConfig = { provider, baseUrl, model, apiKey: key };
  const startedAt = Date.now();
  const r = await chatComplete(cfg, {
    messages: [{ role: "user", content: "收到请只回复两个字：收到" }],
    maxTokens: 16,
    timeoutMs: 120_000,
  });
  return { ok: true, latencyMs: Date.now() - startedAt, model, reply: r.text.trim() };
}

export function saveRp(enabled: boolean) {
  const { db } = ctx();
  return setRpEnabled(db, enabled);
}

export function saveChatMaster(masterId: string | null) {
  const { db, userId } = ctx();
  if (!setChatMaster(db, userId, masterId)) throw new Error("会长不存在或已归档");
  return settingsState();
}

export async function saveImage(patch: Partial<ImageConfig> & { apiKey?: string }) {
  const { db } = ctx();
  if (patch.apiKey !== undefined) await setSecret("image", patch.apiKey);
  setImageSettings(db, {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.width !== undefined ? { width: patch.width } : {}),
    ...(patch.height !== undefined ? { height: patch.height } : {}),
    ...(patch.style !== undefined ? { style: patch.style } : {}),
    ...(patch.apiBaseUrl !== undefined ? { apiBaseUrl: patch.apiBaseUrl } : {}),
    ...(patch.apiModel !== undefined ? { apiModel: patch.apiModel } : {}),
  });
  return getImageConfig(db);
}

const imageRuns = new Map<string, AbortController>();

export function cancelTestImage(token: string) {
  const c = imageRuns.get(token);
  if (!c) return false;
  imageRuns.delete(token);
  c.abort();
  return true;
}

export async function testImage(promptText: string, token: string) {
  const { db } = ctx();
  const cfg = getImageConfig(db);
  if (!cfg.enabled) throw new Error("先在「设置 → 生图」里打开开关。");
  const scene = promptText.trim() || "a quiet room at dusk, warm lamp light";
  const prompt = buildScenePrompt(cfg.style, scene);
  const controller = new AbortController();
  imageRuns.set(token, controller);
  const startedAt = Date.now();
  try {
    const bytes = await generateImage(cfg, { prompt, signal: controller.signal });
    const filename = saveSceneLocal(randomUUID(), bytes);
    return { ok: true, url: assetUrl("scene", filename), prompt, ms: Date.now() - startedAt };
  } finally {
    imageRuns.delete(token);
  }
}

function saveSceneLocal(id: string, bytes: Uint8Array) {
  return saveScene(id, bytes);
}

export function userPersonaGet() {
  const { db } = ctx();
  return getUserPersona(db);
}

export function userPersonaSave(patch: { name?: string; brief?: string; description?: string }) {
  const { db } = ctx();
  return setUserPersona(db, patch);
}

export { getSecret };

// ============================================================ local UI prefs
export function getUiPref(key: string, fallback: string): string {
  const { db } = ctx();
  const row = db.select().from(appSettings).where(eq(appSettings.key, `ui.${key}`)).get();
  return row?.value ?? fallback;
}

/** 页面里 useUiPref 的订阅回调：写偏好后同步通知，跨标签页即时生效。 */
const uiPrefListeners = new Map<string, Set<() => void>>();

export function subscribeUiPref(key: string, onChange: () => void): () => void {
  let set = uiPrefListeners.get(key);
  if (!set) {
    set = new Set();
    uiPrefListeners.set(key, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
  };
}

export function setUiPref(key: string, value: string): void {
  const { db } = ctx();
  const k = `ui.${key}`;
  const now = Date.now();
  const existing = db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, k)).get();
  if (existing) db.update(appSettings).set({ value, updatedAt: now }).where(eq(appSettings.key, k)).run();
  else db.insert(appSettings).values({ key: k, value, updatedAt: now }).run();
  uiPrefListeners.get(key)?.forEach((fn) => fn());
}

export function avatarUri(filename: string | null | undefined): string | null {
  return assetUrl("avatar", filename);
}
