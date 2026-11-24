/**
 * 对话页共用的数据类型。
 *
 * 从 chat-home.tsx 抽出来，原因有二：
 * 1. 消息行 / 时间线等子组件需要同一套类型，避免互相 import 形成环；
 * 2. 页面组件只负责编排，类型与纯函数分开放更好维护。
 */

import type { CeremonyEvent } from "@/components/CeremonyOverlay";
import type { PetDescriptor } from "@/lib/petCatalog";
import type { SettlementCardData } from "@/components/SettlementCard";

export interface ApiMessage {
  id: string;
  role: "user" | "master";
  content: string;
  sender: string;
  createdAt: number;
  /** 本地生图：该消息已配的情景图 URL（无则 null/undefined） */
  image?: string | null;
  /** 后台是否正在为该消息生成配图（刷新/重进后恢复「正在作画」） */
  generating?: boolean;
  generatingSince?: number;
}

export type TimelineItem =
  | { type: "message"; message: ApiMessage }
  | { type: "settlement"; settlement: SettlementCardData; fresh?: boolean };

/** P0 对话模式：quest=任务管线，chat=聊天（酒馆）管线 */
export type Mode = "quest" | "chat";

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface ChatResponse {
  reply?: string;
  error?: string;
  code?: string;
  reminderNotices?: string[];
  settlementNotices?: string[];
  settlements?: SettlementCardData[];
  ceremony?: CeremonyEvent | null;
  /** 本轮落库的真实消息 id（用它们替换本地假 id，生图/删除才找得到） */
  userMessageId?: string;
  masterMessageId?: string;
}

export interface HistoryResponse {
  mode?: Mode;
  /** 增量轮询响应：只含新内容与在途状态，静态字段省略 */
  incremental?: boolean;
  masterName?: string;
  /** 会长头像 URL（酒馆式：卡 PNG 当头像）；null = 用名字首字 */
  masterAvatar?: string | null;
  /** 会长像素小人形象参数；null = 没有 */
  masterSprite?: PetDescriptor | null;
  /** 当前聊天会话的背景图 URL（仅聊天模式） */
  background?: string | null;
  messages?: ApiMessage[];
  settlements?: SettlementCardData[];
  /** 三天窗口之前是否还有内容（任务模式显示「聊天记录」入口；聊天模式=会话还有更早消息） */
  hasEarlier?: boolean;
  /** 本地生图开关（关闭时不显示「给这一幕配图」按钮） */
  imageEnabled?: boolean;
  /** 聊天模式向前翻页游标：下一页 before（null/undefined = 没有更早的了） */
  nextBefore?: number | null;
  windowStart?: number;
  /** P9 聊天模式：开场白候选与当前下标 */
  greeting?: { greetings: string[]; currentIndex: number };
  /** P9 当前会长 id（开场白编辑用） */
  activeMasterId?: string | null;
  /** P10 聊天会话 */
  sessionId?: string | null;
  sessions?: ChatSessionSummary[];
  /** 该 mode/会话是否仍有生成在途（切页回来恢复「正在回复」用） */
  pending?: boolean;
}

export interface Notice {
  text: string;
  at: number;
}
