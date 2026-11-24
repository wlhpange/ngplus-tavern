/**
 * 世界书：解析与激活（与数据库无关的纯逻辑）。
 *
 * 从 worldbook.ts 拆出：关键词匹配/装饰器/预算递归是纯函数，便于单测；
 * 增删改查放在 store.ts。
 */


/**
 * P2 世界书（Lorebook）引擎 —— B 标准档。
 *
 * 对齐 Character Card V2/V3 的 Lorebook 子集，并实现酒馆的关键行为：
 * 常驻(constant) / 关键词 / selective+secondary_keys / scan_depth /
 * insertion_order / 位置(before·after·at_depth) / token 预算 / 概率 /
 * 递归扫描 / 装饰器（@@depth @@position @@role @@scan_depth @@activate 等）。
 * sticky/cooldown/delay/分组/outlet 等未执行的字段原样保留在 extensions。
 */

export type WorldBookPosition = "before" | "after" | "at_depth";
export type WorldBookRole = "system" | "user" | "assistant";

export interface WorldBookEntry {
  id: string;
  /** 0 = 角色书（优先），1 = 全局书 */
  scope: 0 | 1;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  insertionOrder: number;
  position: WorldBookPosition;
  depth: number;
  role: WorldBookRole;
  priority: number | null;
  caseSensitive: boolean;
  useRegex: boolean;
  scanDepth: number | null;
  extensions: Record<string, unknown>;
}

export const DEFAULT_SCAN_DEPTH = 2;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_BUDGET_TOKENS = 1500;
export const MAX_RECURSION_STEPS = 3;

/** 粗略 token 估算（中英混排）：仅用于预算截断，单调即可 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

const KNOWN_DECORATORS = new Set([
  "depth",
  "position",
  "role",
  "scan_depth",
  "activate",
  "dont_activate",
  "additional_keys",
  "exclude_keys",
]);

/**
 * 解析条目正文顶部的装饰器（@@name value；@@@ 为 fallback）。
 * 已知装饰器优先；未知装饰器看下一条 @@@ fallback。返回正文（已剥离装饰器）。
 */
export function parseDecorators(raw: string): {
  decorators: Record<string, string>;
  content: string;
} {
  const decorators: Record<string, string> = {};
  if (!raw.startsWith("@@")) return { decorators, content: raw };

  const lines = raw.split("\n");
  let i = 0;
  let accepted = true;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("@@")) break;
    const isFallback = line.startsWith("@@@");
    const body = isFallback ? line.slice(1) : line;
    const rest = body.slice(2);
    const name = rest.split(/\s/, 1)[0] ?? "";
    const value = rest.slice(name.length).trim();
    if (isFallback) {
      if (!accepted && name) {
        decorators[name] = value;
        accepted = true;
      }
    } else if (KNOWN_DECORATORS.has(name)) {
      decorators[name] = value;
      accepted = true;
    } else {
      accepted = false;
    }
  }
  return { decorators, content: lines.slice(i).join("\n") };
}

interface MatchOpts {
  caseSensitive?: boolean;
  useRegex?: boolean;
}

/** 关键词匹配（支持正则与大小写） */
export function matchKeys(haystack: string, keys: string[], opts: MatchOpts = {}): boolean {
  if (keys.length === 0) return false;
  const hay = opts.caseSensitive ? haystack : haystack.toLowerCase();
  return keys.some((raw) => {
    const k = raw?.trim();
    if (!k) return false;
    if (opts.useRegex) {
      try {
        return new RegExp(k, opts.caseSensitive ? "" : "i").test(haystack);
      } catch {
        return false;
      }
    }
    const needle = opts.caseSensitive ? k : k.toLowerCase();
    return hay.includes(needle);
  });
}

/** 取最近 depth 条消息拼成扫描缓冲 */
function buildHaystack(messages: { role: string; content: string }[], depth: number): string {
  const n = Math.max(0, depth);
  const recent = n === 0 ? [] : messages.slice(Math.max(0, messages.length - n));
  return recent.map((m) => m.content).join("\n");
}

export interface ActivateOptions {
  /** 最近消息（时间正序，最后一条最新） */
  messages: { role: string; content: string }[];
  budgetTokens?: number;
  /** 递归扫描开关（默认开，B 标准档） */
  recursive?: boolean;
}

export interface ActivatedWorldBook {
  before: string;
  after: string;
  depth: { depth: number; role: WorldBookRole; content: string }[];
  /** 本回合激活的条目 id（调试/测试/事件用） */
  activated: string[];
}

/**
 * 激活世界书：扫描 → 命中 → 预算截断 → 递归 → 按位置组装。
 * 纯函数（不碰 DB），可单测。
 */
export function activateWorldBook(
  entries: WorldBookEntry[],
  opts: ActivateOptions,
): ActivatedWorldBook {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const recursive = opts.recursive ?? true;

  // 角色书优先（scope 0），其次按 insertion_order 升序（低者先入提示词）
  const sorted = [...entries].sort(
    (a, b) => a.scope - b.scope || a.insertionOrder - b.insertionOrder || a.id.localeCompare(b.id),
  );

  const activated = new Map<string, WorldBookEntry>();
  const effectiveContent = new Map<string, string>();
  const effectiveDecorators = new Map<string, Record<string, string>>();
  let tokens = 0;
  let recurse = "";
  let steps = 0;
  let progressed = true;

  while (progressed && steps <= MAX_RECURSION_STEPS) {
    progressed = false;
    for (const entry of sorted) {
      if (activated.has(entry.id) || !entry.enabled) continue;

      const { decorators, content } = parseDecorators(entry.content);
      const scanDepth = decorators.scan_depth
        ? Number(decorators.scan_depth)
        : entry.scanDepth ?? DEFAULT_SCAN_DEPTH;
      const haystack = buildHaystack(opts.messages, scanDepth) + recurse;

      if (!entryMatches(entry, haystack, decorators)) continue;

      const cost = estimateTokens(content);
      const ignoreBudget = entry.extensions.ignore_budget === true;
      if (!ignoreBudget && tokens + cost > budget) continue; // 预算溢出：跳过（低优先级/低序先被丢）

      activated.set(entry.id, entry);
      effectiveContent.set(entry.id, content);
      effectiveDecorators.set(entry.id, decorators);
      tokens += cost;
      progressed = true;
      const preventRecursion = entry.extensions.prevent_recursion === true;
      if (!preventRecursion) recurse += "\n" + content;
    }
    steps++;
    if (!recursive) break;
  }

  // 组装：按 scope + insertion_order（低者在前）
  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  const depthGroups = new Map<string, { depth: number; role: WorldBookRole; parts: string[] }>();

  for (const entry of sorted) {
    if (!activated.has(entry.id)) continue;
    const content = effectiveContent.get(entry.id) ?? entry.content;
    if (!content.trim()) continue;
    const decorators = effectiveDecorators.get(entry.id) ?? {};
    const position = (decorators.position as WorldBookPosition) ?? entry.position;
    const depth = decorators.depth ? Number(decorators.depth) : entry.depth;
    const role = (decorators.role as WorldBookRole) ?? entry.role;

    if (position === "after") {
      afterParts.push(content);
    } else if (position === "at_depth") {
      const key = `${depth}::${role}`;
      const g = depthGroups.get(key) ?? { depth, role, parts: [] };
      g.parts.push(content);
      depthGroups.set(key, g);
    } else {
      beforeParts.push(content);
    }
  }

  return {
    before: beforeParts.join("\n"),
    after: afterParts.join("\n"),
    depth: [...depthGroups.values()].map((g) => ({
      depth: g.depth,
      role: g.role,
      content: g.parts.join("\n"),
    })),
    activated: [...activated.keys()],
  };
}

/** 激活结果拼成一段注入文本（任务模式用；聊天模式按位置分别处理） */
export function activatedWorldBookText(a: ActivatedWorldBook): string {
  return [a.before, a.after, ...a.depth.map((d) => d.content)]
    .filter((s) => s.trim().length > 0)
    .join("\n");
}

/** 单条命中判定（含装饰器强制开关与 selective/secondary/additional/exclude） */
function entryMatches(
  entry: WorldBookEntry,
  haystack: string,
  decorators: Record<string, string>,
): boolean {
  if (decorators.activate !== undefined) return true;
  if (decorators.dont_activate !== undefined) return false;
  if (entry.constant) return true;

  const cs = entry.caseSensitive;
  const rx = entry.useRegex;
  const primary = matchKeys(haystack, entry.keys, { caseSensitive: cs, useRegex: rx });
  if (!primary) return false;

  if (entry.selective && entry.secondaryKeys.length > 0) {
    if (!matchKeys(haystack, entry.secondaryKeys, { caseSensitive: cs, useRegex: rx })) {
      return false;
    }
  }
  // 装饰器附加/排除关键词
  if (decorators.additional_keys) {
    const keys = decorators.additional_keys.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length && !matchKeys(haystack, keys, { caseSensitive: cs, useRegex: rx })) {
      return false;
    }
  }
  if (decorators.exclude_keys) {
    const keys = decorators.exclude_keys.split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length && matchKeys(haystack, keys, { caseSensitive: cs, useRegex: false })) {
      return false;
    }
  }
  return true;
}

