import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { appSettings } from "./db/schema";

/**
 * P4 内容尺度设置（R18 开关）。
 * 单用户、本机运行：是否放开R18 内容由用户自己决定。
 * 只存一个布尔开关在 app_settings；真正的内容策略由聊天提示词层表达。
 */

const KEY_RP_ENABLED = "rp.enabled";

export interface RpSettings {
  /** true = 允许R18 内容 */
  enabled: boolean;
}

export function getRpSettings(db: Db): RpSettings {
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, KEY_RP_ENABLED))
    .get();
  return { enabled: row?.value === "1" };
}

export function setRpEnabled(db: Db, enabled: boolean): RpSettings {
  const value = enabled ? "1" : "0";
  const now = Date.now();
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, KEY_RP_ENABLED))
    .get();
  if (row) {
    db.update(appSettings)
      .set({ value, updatedAt: now })
      .where(eq(appSettings.key, KEY_RP_ENABLED))
      .run();
  } else {
    db.insert(appSettings).values({ key: KEY_RP_ENABLED, value, updatedAt: now }).run();
  }
  return { enabled };
}
