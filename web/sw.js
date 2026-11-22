/* 云岛的后台脚本：让页面打开得快。
   打开页面时先用手机里存着的那份（不等网络：冷启动建连、经代理或隧道等首字节可能要 1 到 3 秒），同时在后台取新的存起来。
   新的跟存着的不一样（etag 变了）就告诉页面，页面自己决定马上换（刚打开、还没动）还是提示一声。
   网址带 ?fresh 时不用存着的，直接走网络。只存同源、状态 200、没经过跳转的页面本身；登录跳转、5xx 一律不存。
   只管 sw.js 所在这一层的打开页面（页面放在哪个路径下都行），接口照常走网络。 */
const CACHE = 'yundao-page';
const pageKey = (u) => { const x = new URL(u); return x.origin + x.pathname; };
const storable = (res) => res && res.status === 200 && res.type === 'basic' && !res.redirected;

async function tell(msg) {
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(msg);
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const res = await fetch(self.registration.scope, { cache: 'no-store', redirect: 'manual' });
      if (storable(res)) await (await caches.open(CACHE)).put(pageKey(self.registration.scope), res);
    } catch (err) {}
  })());
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// 推送：后端发来 { title, body, tag, url: "/?ai=…", ai, kind }。url 以 / 开头、按站点根写的，
// 网页放在子路径下（比如 /app/）时前面补上这一层（sw.js 所在的目录）
const scopePath = () => new URL(self.registration.scope).pathname.replace(/\/$/, '');
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  const url = scopePath() + (typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/');
  e.waitUntil(self.registration.showNotification(d.title || '云岛', { body: d.body || '', tag: d.tag || undefined, data: { url, ai: d.ai || '' } }));
});
// 点通知：网页开着就切过去、换到那个 AI；没开就新开一个
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {}, url = new URL(d.url || self.registration.scope, self.location.origin).href;
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) { c.postMessage({ type: 'yd-open', ai: d.ai }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

// 页面旁边的静态文件（图片、开屏字幕用的霞鹜文楷 lxgwwenkai-light.css 和它的 .woff2 切片）：文件名不变、内容不变，
// 有就直接用存着的，没有才走网络，取到存下，开屏不再等网络。
// 存了就一直用存着的：以后要换字体或改这份样式，换个文件名（不然手机上还是旧的）
const IMG = 'yundao-img';
const isImg = (u) => u.origin === self.location.origin && u.pathname.startsWith(new URL(self.registration.scope).pathname)
  && !u.pathname.includes('/api/') && (/\.(jpe?g|png|webp|gif|woff2)$/i.test(u.pathname) || /\/lxgwwenkai-light\.css$/.test(u.pathname));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'GET' && isImg(new URL(req.url))) {
    e.respondWith((async () => {
      const c = await caches.open(IMG), hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (storable(res)) c.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  // 只存云岛主页面本身（scope 或 scope + index.html）。别的页面每次走网络——
  // 以前一律先给存着的，改了别的页面（比如自己加的测试页）打开看到的总是上一次的版本
  const sp = new URL(self.registration.scope).pathname;
  if (url.pathname !== sp && url.pathname !== sp + 'index.html') return;
  const key = pageKey(req.url);
  const fresh = url.searchParams.has('fresh');
  const net = (async () => {
    const res = await fetch(req, { cache: 'no-store' });
    if (storable(res)) {
      const c = await caches.open(CACHE), old = await c.match(key);
      const changed = !old || old.headers.get('etag') !== res.headers.get('etag');
      await c.put(key, res.clone());
      if (changed) tell({ type: 'yd-page-new' });
    } else if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      tell({ type: 'yd-need-login' });
    }
    return res;
  })();
  e.respondWith((async () => {
    const hit = fresh ? null : await caches.match(key, { cacheName: CACHE });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }    // 先用存着的，秒开
    try {
      const res = await net;
      if (res.status >= 500) { const old = await caches.match(key, { cacheName: CACHE }); if (old) return old; }
      return res;
    } catch (err) {
      return (await caches.match(key, { cacheName: CACHE })) || Response.error();
    }
  })());
});
