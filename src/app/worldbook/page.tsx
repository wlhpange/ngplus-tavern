import { bootstrap } from "@/server/bootstrap";
import { listSelectableMasters } from "@/server/masters";
import WorldBookClient from "./worldbook";

export const dynamic = "force-dynamic";

/**
 * 世界书管理（P6 书册化）：一本世界书可挂给多位会长，一位会长可挂多本。
 * 全局书唯一、始终生效。书册列表在客户端拉取（/api/worldbook）。
 */
export default function Page() {
  const { db, userId } = bootstrap();
  const masters = listSelectableMasters(db, userId).map((m) => ({
    id: m.id,
    name: m.name,
    isOfficial: m.isOfficial,
  }));
  return <WorldBookClient masters={masters} />;
}
