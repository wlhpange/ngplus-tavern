/* 二周目协会 Service Worker
 *
 * 职责范围刻意收窄：
 * 1. 一个极简 app shell 缓存，让冷启动不至于是白屏
 * 2. 断网时兜底返回缓存
 *
 * 历史注：Web Push 展示/点击处理已随通知功能下线（V1.9）。
 * 不做的：离线数据同步、后台周期性同步（V2 再说）。
 * 缓存策略：network-first。自律应用的数据必须新鲜，
 * 缓存只作断网兜底，绝不能让用户看到过期的战果。
 */

const CACHE = "ngplus-shell-v1";
const SHELL = ["/", "/quests", "/character", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
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

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit ?? caches.match("/"))),
  );
});
