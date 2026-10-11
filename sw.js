// Service Worker: App-Dateien offline verfügbar, Kartenkacheln werden beim Ansehen zwischengespeichert.
const APP = 'sk-app-v1', TILES = 'sk-tiles-v1';
const SHELL = ['./', 'index.html', 'app.css?v=1', 'app.js?v=1', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
let puts = 0;
async function trim() {
  const c = await caches.open(TILES), keys = await c.keys();
  for (let i = 0; i < keys.length - 4000; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isTile = /tile\.openstreetmap\.org|tiles\.openseamap\.org|arcgisonline\.com|emodnet/.test(u.host);
  if (isTile) { // Netz zuerst (aktuell), Cache als Rückfall ohne Internet
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok || r.type === 'opaque') { const cl = r.clone(); caches.open(TILES).then((c) => c.put(e.request, cl)); if (++puts % 200 === 0) trim(); }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || Response.error())));
    return;
  }
  if (u.origin === location.origin || u.host === 'cdnjs.cloudflare.com') {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cl = r.clone(); caches.open(APP).then((c) => c.put(e.request, cl)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: false }).then((r) => r || caches.match('index.html'))));
  }
});
