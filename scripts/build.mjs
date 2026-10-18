/**
 * 构建包装器（pnpm build）——解决 Next 14.2 在本机（容器/overlayfs）上的
 * 内部产物竞态。
 *
 * 现象：`next build` 偶发在"收集页面数据 / 生成静态页 / 收集 build trace"阶段
 * 报 ENOENT，指向的全是 Next 自己刚写过的文件：
 *   .next/build-manifest.json
 *   .next/static/<hash>/_ssgManifest.js
 *   .next/export/500.html（rename 到 .next/server/pages/500.html）
 *   .next/types/app/**（tsconfig include 了 .next/types，被中途清掉）
 * 源码编译阶段始终 `✓ Compiled successfully`，说明与业务代码无关；
 * 在同一 .next 上直接重跑即可通过（首次失败率约 50%）。
 *
 * 处理：失败即重试，最多 3 次；每次清掉 .next 的中间产物避免半成品干扰。
 * 这是环境稳定性问题的工程性规避，不是掩盖真实错误——
 * 只有命上述"内部产物 ENOENT"才重试，编译/类型/业务错误一律直接失败。
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const MAX_ATTEMPTS = 3;

/** 判定本次失败是否属于"可重试的构建产物竞态" */
function isRetryable(log) {
  if (/Failed to compile/.test(log)) return false; // 源码编译失败 → 真错
  if (/Type error:/.test(log) && !/\.next\/types/.test(log)) return false; // 业务类型错误
  return (
    /ENOENT/.test(log) ||
    /PageNotFoundError/.test(log) ||
    /UnhandledSchemeError/.test(log)
  );
}

let lastLog = "";
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  if (attempt > 1) {
    console.log(`\n[build] 第 ${attempt} 次尝试（清理 .next 中间产物后重试）…\n`);
    rmSync(".next", { recursive: true, force: true });
  }

  // Windows 下 spawnSync("npx") 无法执行 .cmd（Node 22 安全限制），改用
  // node 直接跑 next 的 JS 入口，跨平台一致。
  const res = spawnSync(
    process.execPath,
    ["node_modules/next/dist/bin/next", "build"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: process.env,
    },
  );
  if (res.error) {
    console.error("[build] 启动 next build 失败：", res.error.message);
    process.exit(1);
  }
  const log = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  lastLog = log;
  process.stdout.write(log);

  if (res.status === 0) {
    if (attempt > 1) console.log(`\n[build] 第 ${attempt} 次尝试成功。`);
    process.exit(0);
  }

  if (!isRetryable(log)) {
    console.error("\n[build] 编译失败（非环境竞态），不重试。");
    process.exit(res.status ?? 1);
  }
  console.error(
    `\n[build] 第 ${attempt} 次失败：Next 内部产物竞态（ENOENT），准备重试…`,
  );
}

console.error("\n[build] 连续重试仍失败，最后一次输出如下（末尾 40 行）：");
console.error(lastLog.split("\n").slice(-40).join("\n"));
process.exit(1);
