import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/server/db";
import { appSettings, quests } from "@/server/db/schema";
import { ensureSeed, LOCAL_USER_ID } from "@/server/db/seed";
import { ensureInflightBootCleanup } from "@/server/inflight";
import { runOverdueSweep } from "@/server/cron/jobs";
import { hydrateSecrets } from "@/server/secure";
import { installPolyfills } from "./polyfills";

const LAST_SWEEP = "mobile.last_sweep_day";
const NOTIF_DAILY = "mobile.notif.daily";
const NOTIF_WEEKLY = "mobile.notif.weekly";

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readSetting(key: string): string | null {
  const row = getDb().select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  const existing = db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).get();
  if (existing) db.update(appSettings).set({ value, updatedAt: now }).where(eq(appSettings.key, key)).run();
  else db.insert(appSettings).values({ key, value, updatedAt: now }).run();
}

let initialized = false;
export function initApp(): void {
  if (initialized) return;
  installPolyfills();
  const db = getDb();
  ensureInflightBootCleanup(db);
  ensureSeed(db, LOCAL_USER_ID);
  void hydrateSecrets();
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    /* 通知模块不可用（Expo Go / 无权限）不阻断启动 */
  }
  initialized = true;
}

export async function waitForSecrets(): Promise<void> {
  await hydrateSecrets();
}

export interface CatchUpResult {
  sweptDays: number;
  mutated: number;
  overdueNotified: boolean;
}

/**
 * 启动 / 回前台补算：
 * - 逾期巡检按「上次执行日 → 今天」逐日补跑（移动端没有常驻进程）；
 * - 周常无需写入：weeklyBoss 状态由 weekKey 计算，跨周自然重置；
 * - 补算发现断签时发一条本地通知。
 */
export async function runCatchUp(): Promise<CatchUpResult> {
  const db = getDb();
  const now = new Date();
  const today = dayKey(now);
  const last = readSetting(LAST_SWEEP);
  let sweptDays = 0;
  let mutated = 0;

  if (last !== today) {
    const start = last ? new Date(`${last}T01:00:00`) : new Date(now);
    if (!last) start.setDate(start.getDate() - 1);
    const cursor = new Date(start);
    cursor.setDate(cursor.getDate() + 1);
    while (dayKey(cursor) <= today) {
      const at = new Date(cursor);
      at.setHours(1, 0, 0, 0);
      const report = await runOverdueSweep(db, at, { atHour: null });
      if (report.scanned > 0) sweptDays++;
      mutated += report.mutated;
      cursor.setDate(cursor.getDate() + 1);
    }
    writeSetting(LAST_SWEEP, today);
  }

  let overdueNotified = false;
  if (mutated > 0) {
    overdueNotified = await notifyNow(
      "协会的灯还亮着",
      "昨天有委托断了签。连击会衰减，去和会长说一声吧。",
    );
  }
  await refreshScheduledReminders();
  return { sweptDays, mutated, overdueNotified };
}

export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

async function notifyNow(title: string, body: string): Promise<boolean> {
  try {
    if (!(await ensureNotificationPermission())) return false;
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: false },
      trigger: null,
    });
    return true;
  } catch {
    return false;
  }
}

/** 每日 21:00 提醒汇报；周日 20:00 提醒周常。重复调度前先撤销旧的。 */
export async function refreshScheduledReminders(): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) return;
    await Notifications.setNotificationChannelAsync("ngplus-reminders", {
      name: "协会提醒",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180],
      lightColor: "#D9B061",
    });
    const db = getDb();
    const activeDaily = db
      .select({ id: quests.id })
      .from(quests)
      .where(and(eq(quests.userId, LOCAL_USER_ID), eq(quests.status, "active"), eq(quests.type, "daily")))
      .all().length;

    const oldDaily = readSetting(NOTIF_DAILY);
    const oldWeekly = readSetting(NOTIF_WEEKLY);
    if (oldDaily) await Notifications.cancelScheduledNotificationAsync(oldDaily).catch(() => {});
    if (oldWeekly) await Notifications.cancelScheduledNotificationAsync(oldWeekly).catch(() => {});

    if (activeDaily > 0) {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: "二周目协会",
          body: `今天还有 ${activeDaily} 件日常委托没落账。去和会长说一声吧。`,
          sound: false,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: 21,
          minute: 0,
          channelId: "ngplus-reminders",
        },
      });
      writeSetting(NOTIF_DAILY, id);
    }
    const weekId = await Notifications.scheduleNotificationAsync({
      content: {
        title: "本周悬赏",
        body: "新的一周。看看协会这周给你挂了什么悬赏。",
        sound: false,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: 1,
        hour: 20,
        minute: 0,
        channelId: "ngplus-reminders",
      },
    });
    writeSetting(NOTIF_WEEKLY, weekId);
  } catch {
    /* 通知不可用不影响玩法 */
  }
}

/** 注册回前台补算。返回取消函数。 */
export function watchForeground(onCatchUp: (r: CatchUpResult) => void): () => void {
  let last: AppStateStatus | null = (AppState.currentState as AppStateStatus) ?? null;
  const sub = AppState.addEventListener("change", (next) => {
    if ((last === "inactive" || last === "background") && next === "active") {
      void runCatchUp().then(onCatchUp).catch(() => {});
    }
    last = next;
  });
  return () => sub.remove();
}
