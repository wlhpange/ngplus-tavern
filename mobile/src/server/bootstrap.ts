import { getDb } from "./db";
import { ensureSeed, LOCAL_USER_ID } from "./db/seed";
import { ensureInflightBootCleanup } from "./inflight";

let booted = false;

/** 服务端懒初始化：建表 + 幂等种子（user/character/薇拉/save） */
export function bootstrap() {
  const db = getDb();
  // 进程启动时清掉上个进程遗留的在途标记（每个进程只清一次）
  ensureInflightBootCleanup(db);
  if (!booted) {
    ensureSeed(db, LOCAL_USER_ID);
    booted = true;
  }
  return { db, userId: LOCAL_USER_ID };
}
