/**
 * better-sqlite3 预编译产物保障脚本（postinstall 钩子）。
 *
 * 背景：本机（Windows）访问 GitHub releases 不稳定导致 prebuild-install 下载失败，
 * 又没有 C++ 编译工具链（node-gyp 必败）；且 pnpm 每次安装都会重跑安装脚本并清空
 * build/ 目录。方案：pnpm-workspace.yaml 里把 better-sqlite3 的构建脚本关掉，
 * 由本脚本在 postinstall 阶段从 npmmirror 二进制镜像拉取对应 ABI 的预编译产物。
 *
 * 已就位（文件存在）则静默跳过——重复执行安全。
 */
import { execSync } from "node:child_process";
import {
  createRequire,
} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("better-sqlite3/package.json");
const pkgRoot = path.dirname(pkgPath);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const targetDir = path.join(pkgRoot, "build", "Release");
const targetFile = path.join(targetDir, "better_sqlite3.node");

if (fs.existsSync(targetFile)) {
  console.log("[patch-sqlite3] binding 已存在，跳过");
  process.exit(0);
}

const version = pkg.version;
const abi = process.versions.modules;
const platform = os.platform() === "win32" ? "win32" : os.platform();
const arch = os.arch();
const tarball = `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`;
const url = `https://registry.npmmirror.com/-/binary/better-sqlite3/v${version}/${tarball}`;

console.log(`[patch-sqlite3] 拉取预编译产物：${url}`);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsqlite-"));
const tarballPath = path.join(tmpDir, tarball);
try {
  execSync(`curl -fsSL --max-time 300 -o "${tarballPath}" "${url}"`, {
    stdio: "inherit",
  });
  // GNU tar 会把 "C:\..." 当远程主机名，故在临时目录内用相对路径解压
  execSync(`tar -xzf "${tarball}"`, { cwd: tmpDir, stdio: "inherit" });
  const extracted = path.join(tmpDir, "build", "Release", "better_sqlite3.node");
  if (!fs.existsSync(extracted)) {
    throw new Error(`压缩包内未找到 better_sqlite3.node（${tarball}）`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(extracted, targetFile);
  console.log(`[patch-sqlite3] 已安装到 ${targetFile}`);
} catch (e) {
  console.error(
    `[patch-sqlite3] 拉取失败：${e.message}\n` +
      `手动方案：从 ${url} 下载并解压，把 build/Release/better_sqlite3.node ` +
      `放到 ${targetDir}/`,
  );
  process.exit(1);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
