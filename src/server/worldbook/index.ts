/**
 * 世界书模块入口：保持 `@/server/worldbook` 的既有导入路径不变。
 * - core：解析 / 关键词匹配 / 激活（纯函数）
 * - store：书册、条目、会长分配的增删改查
 */
export * from "./core";
export * from "./store";
