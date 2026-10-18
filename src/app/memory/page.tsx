import { bootstrap } from "@/server/bootstrap";
import { listSelectableMasters, getChatMasterId } from "@/server/masters";
import MemoryClient from "./memory";

export const dynamic = "force-dynamic";

/**
 * P12 记忆书管理页（二级页，从设置进入）。
 * 条目由 AI 对局中自动整理，这里可像世界书一样增删改、启用/停用、批量删除。
 * 两级 scope：会长级「永久记忆」一本 + 每段酒馆对话各自的私有记忆。
 */
export default function Page() {
  const { db, userId } = bootstrap();
  const masters = listSelectableMasters(db, userId).map((m) => ({
    id: m.id,
    name: m.name,
  }));
  return (
    <MemoryClient masters={masters} defaultMasterId={getChatMasterId(db, userId)} />
  );
}
