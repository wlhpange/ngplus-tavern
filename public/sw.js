/* 二周目协会 Service Worker
 *
 * 职责范围刻意收窄：
 * 1. 静态资源（带哈希的 _next chunk、图标、像素素材）走缓存，减少重复下载；
 * 2. 页面导航 network-first，断网时兜底缓存的 shell；
 * 3. 绝不缓存 API 与 RSC 数据，保证战果/对话永远来自数据库。
 *
 * 历史注：Web Push 展示/点击处理已随通知功能下线（V1.9）。
 * 不做的：离线数据同步、后台周期性同步（V2 再说）。
 *
 * 缓存上限：浏览器配额有限，旧版本 chunk 与图片不应无限堆积，
 * 每个缓存最多保留 MAX_ENTRIES 条，超出按插入顺序淘汰。
 */

const VERSION = "v2";
const SHELL_CACHE = `ngplus-shell-${VERSION}`;
const STATIC_CACHE = `ngplus-static-${VERSION}`;
const IMAGE_CACHE = `ngplus-image-${VERSION}`;
const CACHE_NAMES = [SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE];

const SHELL = ["/", "/quests", "/character", "/manifest.webmanifest"];
const MAX_ENTRIES = 120;

async function putWithLimit(cacheName, request, response) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  const keys = await cache.keys();
  if (keys.length > MAX_ENTRIES) {
    await Promise.all(
      keys.slice(0, keys.length - MAX_ENTRIES).map((key) => cache.delete(key)),
    );
  }
}

/** 带哈希的构建产物：命中缓存直接返回，否则下载并缓存 */
async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok) putWithLimit(cacheName, event.request, res.clone()).catch(() => {});
  return res;
}

/** 图标/像素素材：先给缓存，后台更新（stale-while-revalidate） */
async function staleWhileRevalidate(event, cacheName) {
  const hit = await caches.match(event.request);
  const network = fetch(event.request)
    .then((res) => {
      if (res.ok) putWithLimit(cacheName, event.request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return hit || (await network) || Response.error();
}

/** 页面导航：始终以网络为准，断网才回退缓存 */
async function networkFirstNavigation(event) {
  try {
    const res = await fetch(event.request);
    if (res.ok) putWithLimit(SHELL_CACHE, event.request, res.clone()).catch(() => {});
    return res;
  } catch {
    return (
      (await caches.match(event.request)) ||
      (await caches.match("/")) ||
      Response.error()
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !CACHE_NAMES.includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API 一律不走缓存：状态必须来自数据库
  if (url.pathname.startsWith("/api/")) return;

  // RSC 数据请求不缓存：回放旧数据会让页面显示过期内容
  if (req.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(event, STATIC_CACHE));
    return;
  }

  if (url.pathname.startsWith("/icons/") || url.pathname.startsWith("/sprites/")) {
    event.respondWith(staleWhileRevalidate(event, IMAGE_CACHE));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  // 其它同源 GET 交给网络，不写缓存
});
