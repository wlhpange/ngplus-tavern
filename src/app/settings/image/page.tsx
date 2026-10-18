import ImageSettingsClient from "./image";

export const dynamic = "force-dynamic";

/** 本地生图设置（二级页）：从设置首页拆出。 */
export default function Page() {
  return <ImageSettingsClient />;
}
