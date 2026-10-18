import { Suspense } from "react";
import MasterSelect from "./select";

export const dynamic = "force-dynamic";

export default function Page() {
  // 第二幕带 ?first=1 进入（useSearchParams 需要 Suspense 边界）
  return (
    <Suspense fallback={<div className="h-dvh bg-bg" />}>
      <MasterSelect />
    </Suspense>
  );
}
