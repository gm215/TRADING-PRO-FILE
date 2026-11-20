// Trading Pro-File service worker (build 82).
// The app page is loaded from the network first, so every update shows at once;
// a copy is kept so the app still opens without internet. Libraries and fonts are cached after first use.
const CACHE = 'tp-82';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'privacy.html'];
const LIB_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // live data and AI never come from the cache
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  if (/firestore\.googleapis\.com|identitytoolkit|securetoken|googleapis\.com\/v1|metals\.dev/.test(url.href)) return;
  // the app page: network first (3.5 s), then the saved copy
  if (req.mode === 'navigate' || (url.origin === self.location.origin && /\/(index\.html)?$/.test(url.pathname))) {
    event.respondWith(Promise.race([fetch(req), timeout(3500)]).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => { c.put('index.html', copy.clone()); c.put('./', copy); }); }
      return res;
    }).catch(() => caches.match('index.html').then((r) => r || caches.match('./'))));
    return;
  }
  // own files and libraries: saved copy first, refreshed in the background
  if (url.origin === self.location.origin || LIB_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});
