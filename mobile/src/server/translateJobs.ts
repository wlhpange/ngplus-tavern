import { randomUUID } from "./util/id";
import type { Db } from "./db";
import type { ImportedCard } from "./cardImport";
import { createMasterFromCard } from "./masters";
import { requireLlmConfig } from "./modelConfig";
import {
  translateImportedCard,
  countTranslationUnits,
  TranslateCancelledError,
} from "./translate";

/**
 * P11 翻译任务：后台跑（不阻塞 HTTP），前端轮询进度。
 * 单用户本机应用，用内存 Map 存任务即可；完成后保留一小段时间供前端取结果。
 */

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface TranslateJob {
  id: string;
  status: JobStatus;
  done: number;
  total: number;
  error?: string;
  /** 完成后的落库结果 */
  result?: { masterId: string; name: string; worldBookEntries: number };
  cancelled: boolean;
  createdAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, TranslateJob>();
const TTL_MS = 5 * 60_000;

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > TTL_MS) jobs.delete(id);
  }
}

export function getJob(id: string): TranslateJob | undefined {
  sweep();
  const j = jobs.get(id);
  return j ? { ...j } : undefined;
}

export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return false;
  j.cancelled = true;
  return true;
}

/**
 * 启动后台翻译任务，立即返回 jobId。
 * 流程：翻译 → 落库；进度写入 job，前端轮询。
 */
export function startTranslateJob(db: Db, userId: string, card: ImportedCard): string {
  sweep();
  const id = randomUUID();
  const job: TranslateJob = {
    id,
    status: "running",
    done: 0,
    total: countTranslationUnits(card),
    cancelled: false,
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  (async () => {
    try {
      const model = requireLlmConfig(db);
      const r = await translateImportedCard(model, card, {
        onProgress: (done, total) => {
          job.done = done;
          job.total = total;
        },
        shouldStop: () => job.cancelled,
      });
      if (job.cancelled) {
        job.status = "cancelled";
        return;
      }
      const created = createMasterFromCard(db, userId, r.card);
      job.result = {
        masterId: created.id,
        name: created.name,
        worldBookEntries: created.worldBookEntries,
      };
      job.status = "done";
    } catch (e) {
      if (e instanceof TranslateCancelledError || job.cancelled) {
        job.status = "cancelled";
      } else {
        job.status = "error";
        job.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return id;
}
