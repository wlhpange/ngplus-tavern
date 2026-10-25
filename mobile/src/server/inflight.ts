import { eq, like } from "drizzle-orm";
import type { Db } from "./db";
import { appSettings } from "./db/schema";

/**
 * 在途状态登记（持久化到 app_settings）。
 *
 * 「正在回复」与「正在作画」原本只是进程内 Map：浏览器刷新一般还在，但 dev 下
 * 服务端模块重编译、或进程重启就会丢，指示器消失。这里把状态**镜像**到数据库，
 * 内存 Map 仍是快路径；一旦内存丢了，就从库里的镜像恢复。
 *
 * 键统一以 `inflight.` 前缀，进程启动时一次性清掉（上个进程的任务已经不存在了）。
 */

const PREFIX = "inflight.";

export function inflightKey(kind: "turn" | "scene", scope: string): string {
  return `${PREFIX}${kind}.${scope}`;
}

export function setInflightRow(db: Db, key: string, value: string): void {
  const now = Date.now();
  const existing = db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  if (existing) {
    db.update(appSettings).set({ value, updatedAt: now }).where(eq(appSettings.key, key)).run();
  } else {
    db.insert(appSettings).values({ key, value, updatedAt: now }).run();
  }
}

export function getInflightRow(db: Db, key: string): string | null {
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.value ?? null;
}

export function delInflightRow(db: Db, key: string): void {
  db.delete(appSettings).where(eq(appSettings.key, key)).run();
}

/** 进程启动时清理上个进程遗留的在途标记（幂等） */
export function clearInflightRows(db: Db): void {
  db.delete(appSettings).where(like(appSettings.key, `${PREFIX}%`)).run();
}

const BOOT_FLAG = Symbol.for("ngplus.inflight.boot-cleared");

/**
 * 每个进程只清一次：用 globalThis 上的 Symbol 做标记，这样 dev 下模块热重载
 * 不会重复清理（同一进程里正在跑的任务要保住），而真正的进程重启会重新清。
 */
export function ensureInflightBootCleanup(db: Db): void {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[BOOT_FLAG]) return;
  g[BOOT_FLAG] = true;
  clearInflightRows(db);
}
