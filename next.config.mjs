/** @type {import('next').NextConfig} */
// Node-only 服务端依赖：better-sqlite3（原生模块，内部 require fs/path）、
// web-push（https-proxy-agent → node:http/https/net）、node-cron（Node 定时器）。
// 这些包绝不能被 webpack 打进 bundle（否则报 Can't resolve 'fs'/'path'）。
const NODE_EXTERNALS = ["better-sqlite3", "web-push", "node-cron"];

const nextConfig = {
  experimental: {
    // 服务端组件外部化（App Router 的常规路径）
    serverComponentsExternalPackages: NODE_EXTERNALS,
    // M5：启用 instrumentation 启动钩子（src/instrumentation.ts 拉起 cron）
    instrumentationHook: true,
  },
  webpack: (config, { isServer }) => {
    // instrumentation.ts 是独立入口，serverComponentsExternalPackages 不覆盖它，
    // 会尝试从 src/server/db/index.ts 打包 better-sqlite3 → 构建失败。
    // 这里在 webpack 层再兜一层 externals，确保服务端 bundle 一律不打包上述包。
    //
    // DESIGN-DECISION: Node 内建模块的处理有两条约束同时成立：
    // 1. `node:path` 这类 URI 必须外部化，否则 webpack 报 UnhandledSchemeError；
    // 2. 但不能写成 `commonjs node:path` —— 该写法会干扰 Next 的 output file
    //    tracing，导致 collect-build-traces 阶段 `_not-found/page.js.nft.json` ENOENT。
    // 解法：剥离 `node:` 前缀后按裸模块外部化（`commonjs path`），
    // Node 运行时对裸名与 node: 前缀一视同仁，两边约束同时满足。
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        ({ request }, callback) => {
          if (!request) return callback();
          // 原生/Node-only 第三方包
          if (NODE_EXTERNALS.some((p) => request === p || request.startsWith(`${p}/`))) {
            return callback(null, `commonjs ${request}`);
          }
          // Node 内建模块：剥离 node: 前缀后外部化
          if (request.startsWith("node:")) {
            return callback(null, `commonjs ${request.slice("node:".length)}`);
          }
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
