import ModelSettingsClient from "./model";

export const dynamic = "force-dynamic";

/** 模型与渠道设置（二级页）：从设置首页拆出。 */
export default function Page() {
  return <ModelSettingsClient />;
}
