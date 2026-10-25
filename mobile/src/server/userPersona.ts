import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { appSettings } from "./db/schema";

/**
 * P9 冒险者卡（用户侧 persona）。
 * 会长卡是「会长是谁」，冒险者卡是「你是谁」——两模式提示词都会注入。
 * 存 app_settings（单用户本机），字段精简：名字 / 一句话 / 描述。
 */

const KEY_NAME = "user_persona.name";
const KEY_BRIEF = "user_persona.brief";
const KEY_DESC = "user_persona.description";
const ALL = [KEY_NAME, KEY_BRIEF, KEY_DESC];

export interface UserPersona {
  name: string;
  brief: string;
  description: string;
}

function read(db: Db): Map<string, string> {
  const rows = db.select().from(appSettings).all();
  const map = new Map<string, string>();
  for (const r of rows) {
    if (ALL.includes(r.key)) map.set(r.key, r.value);
  }
  return map;
}

export function getUserPersona(db: Db): UserPersona {
  const m = read(db);
  return {
    name: m.get(KEY_NAME) ?? "",
    brief: m.get(KEY_BRIEF) ?? "",
    description: m.get(KEY_DESC) ?? "",
  };
}

function upsert(db: Db, key: string, value: string) {
  const v = value.trim();
  const existing = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!v) {
    if (existing) db.delete(appSettings).where(eq(appSettings.key, key)).run();
    return;
  }
  if (existing) {
    db.update(appSettings).set({ value: v, updatedAt: Date.now() }).where(eq(appSettings.key, key)).run();
  } else {
    db.insert(appSettings).values({ key, value: v, updatedAt: Date.now() }).run();
  }
}

export function setUserPersona(db: Db, patch: Partial<UserPersona>): UserPersona {
  if (patch.name !== undefined) upsert(db, KEY_NAME, patch.name.slice(0, 40));
  if (patch.brief !== undefined) upsert(db, KEY_BRIEF, patch.brief.slice(0, 120));
  if (patch.description !== undefined) upsert(db, KEY_DESC, patch.description.slice(0, 1000));
  return getUserPersona(db);
}

/** 渲染成提示词的一层；空则返回空串（整层省略） */
export function buildUserPersonaLayer(p: UserPersona): string {
  const lines: string[] = [];
  if (p.name) lines.push(`称呼：${p.name}`);
  if (p.brief) lines.push(`一句话：${p.brief}`);
  if (p.description) lines.push(`背景：${p.description}`);
  if (lines.length === 0) return "";
  return ["【关于这位冒险者（ta 自己的设定）】", ...lines].join("\n");
}
