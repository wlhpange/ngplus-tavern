import type { Db } from "../db";
import { inflightKey, setInflightRow, getInflightRow, delInflightRow } from "../inflight";

/**
 * 进行中的对话回合登记（内存 Map + 数据库镜像）。
 *
 * 背景：对话页是客户端组件，「正在回复」的 sending 是本地 state，切到别的页面
 * 再回来组件重挂载、state 丢失，指示器消失；但服务端那次生成其实还在跑。
 * 把「某用户某 mode/会话正在生成」记在服务端，GET /api/chat 时返回，
 * 前端重挂载后据此恢复「正在回复」并轮询到结果落库。
 *
 * 浏览器刷新通常内存还在，但 dev 下服务端模块重编译 / 进程重启会丢——所以同时
 * 镜像一份到数据库，内存 miss 时从库里恢复（见 inflight.ts）。
 *
 * 单用户本机运行：进程内 Map 足够；多 worker 部署需换成共享存储。
 */

/** 略大于 LLM_CALL_TIMEOUT_MS（200s），异常残留不会永远转圈 */
const STALE_MS = 240_000;

const inflight = new Map<string, number>();

/** 登记键：用户 + 模式 + 会话（任务模式 sessionId 为空） */
export function pendingKey(
  userId: string,
  mode: string,
  sessionId?: string | null,
): string {
  return `${userId}:${mode}:${sessionId ?? ""}`;
}

export function markPending(key: string, db?: Db | null): void {
  const now = Date.now();
  inflight.set(key, now);
  if (db) setInflightRow(db, inflightKey("turn", key), String(now));
}

export function clearPending(key: string, db?: Db | null): void {
  inflight.delete(key);
  if (db) delInflightRow(db, inflightKey("turn", key));
}

export function isPending(key: string, db?: Db | null, now = Date.now()): boolean {
  let at = inflight.get(key);
  // 内存里没有（刷新 / 模块重编译 / 进程重启）：从数据库镜像恢复
  if (at == null && db) {
    const v = getInflightRow(db, inflightKey("turn", key));
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        at = n;
        inflight.set(key, n);
      }
    }
  }
  if (at == null) return false;
  if (now - at > STALE_MS) {
    inflight.delete(key);
    if (db) delInflightRow(db, inflightKey("turn", key));
    return false;
  }
  return true;
}

/** 测试用：清空内存快路径，模拟进程内状态丢失，验证数据库镜像可恢复 */
export function __resetPendingMemory(): void {
  inflight.clear();
}
