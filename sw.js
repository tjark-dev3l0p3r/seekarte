// Service Worker Seekarte Live: App startet offline; Karten-/Tiefenkacheln: Cache zuerst (≤ 7 Tage), im Hintergrund aufgefrischt.
// Neue Version wartet, bis die Seite "skip" schickt (Hinweis „Neue Version verfügbar").
const VER = '2.1.0', APP = 'sk-app-' + VER, TILES = 'sk-tiles-3', DATA = 'sk-data-1';
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/';
const SHELL = ['./', 'index.html', 'app.css?v=' + VER, 'app.js?v=' + VER, 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'nok_km.json', 'gauges.json', CDN + 'maplibre-gl.js', CDN + 'maplibre-gl.min.css'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload', mode: u.startsWith('http') ? 'cors' : 'same-origin' })))));
});
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![APP, TILES, DATA].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()).then(() => trim()));
});
async function trim(max = 5000) { const c = await caches.open(TILES), k = await c.keys(); for (const r of k.slice(0, Math.max(0, k.length - max))) await c.delete(r); }
const TILE_HOSTS = /tiles\.openfreemap\.org|tiles\.openseamap\.org|arcgisonline\.com|emodnet-bathymetry\.eu|fonts\.gstatic\.com/;
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (TILE_HOSTS.test(u.host)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES), hit = await c.match(e.request);
      const fresh = hit && Date.now() - Date.parse(hit.headers.get('date') || 0) < 7 * 864e5;
      const net = fetch(e.request).then((r) => { if (r.ok && r.type !== 'opaque') e.waitUntil(c.put(e.request, r.clone()).then(() => Math.random() < 0.02 && trim()).catch(() => {})); return r; });
      if (fresh) { e.waitUntil(net.catch(() => {})); return hit; }
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net.catch(() => Response.error());
    })());
    return;
  }
  if (/supabase\.co$/.test(u.host) && u.pathname.includes('/functions/v1/tides')) { // Gezeiten: Netz zuerst, offline letzter Stand
    e.respondWith(caches.open(DATA).then((c) => fetch(e.request).then((r) => { if (r.ok) e.waitUntil(c.put(e.request, r.clone())); return r; }).catch(() => c.match(e.request).then((r) => r || Response.error()))));
    return;
  }
  if (u.host === 'cdnjs.cloudflare.com') { e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))); return; } // versioniert → Cache zuerst
  if (u.origin === location.origin || /fonts\.googleapis\.com/.test(u.host)) {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cl = r.clone(); e.waitUntil(caches.open(APP).then((c) => c.put(e.request, cl))); } return r; })
      .catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('./') : Response.error())));
  }
});
