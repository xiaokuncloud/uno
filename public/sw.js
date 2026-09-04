/**
 * sw.js — 双人 UNO 离线缓存 Service Worker（PWA）
 * 策略：
 *  - HTML（首页/游戏页）：网络优先，失败回退缓存（保证拿最新页面壳）
 *  - 静态资源（css/js/img/mp3/卡牌）：缓存优先，后台更新（第二次打开秒开）
 */
const CACHE = 'uno-v16';
const CORE = [
  '/',
  '/index.html',
  '/game.html',
  '/css/style.css?v=16',
  '/js/uno-core.js?v=16',
  '/js/qrcode.min.js?v=16',
  '/js/game.js?v=16',
  '/assets/logo3d.png?v=16'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只处理本域资源；WebSocket / 接口请求 / SW 自身不缓存
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/ws')) return;
  if (url.pathname === '/sw.js') return;

  const isHtml = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/game.html';

  if (isHtml) {
    // HTML：网络优先（秒开 + 尽量最新）
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
