/* Seekarte Live — Leaflet + OpenSeaMap + Live-AIS (aisstream.io über eigenes Relay)
   Eigene Position: Tablet-GPS, eigenes AIS (MMSI) oder gewichtetes Mittel aus beidem. */
'use strict';

const RELAY_URL = 'wss://twybfsbfbxvwwxbdphum.supabase.co/functions/v1/ais-relay';
const NM = 1852, KN = 1852 / 3600; // m, m/s
const STALE_MS = 6 * 60e3, DROP_MS = 20 * 60e3;
const $ = (s) => document.querySelector(s);

/* ---------- Einstellungen ---------- */
const DEFAULTS = {
  mmsi: '', source: 'fused', key: '', vecMin: 6, cpaNm: 0.3, tcpaMin: 12, alarm: true, sound: true,
  theme: 'day', seamarks: true, depth: false, sat: false, rings: true, labels: true, track: true,
  demo: false, wake: true, helpSeen: false,
};
const S = Object.assign({}, DEFAULTS, load('sk_settings', {}));
function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* privat/voll */ } }
function save() { store('sk_settings', S); }

// Einrichtung per Link: …/#mmsi=211234567&src=fused&key=…  (Hash geht nie an einen Server)
(function hashSetup() {
  if (!location.hash.includes('=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (/^\d{9}$/.test(p.get('mmsi') || '')) S.mmsi = p.get('mmsi');
  if (['gps', 'ais', 'fused'].includes(p.get('src'))) S.source = p.get('src');
  if ((p.get('key') || '').length >= 20) S.key = p.get('key');
  if (p.get('demo')) S.demo = p.get('demo') === '1';
  save();
  history.replaceState(null, '', location.pathname + location.search);
})();

/* ---------- Geo-Helfer ---------- */
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function distM(a, b) {
  const dφ = rad(b.lat - a.lat), dλ = rad(b.lon - a.lon);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dλ / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function brg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function move(p, bearingDeg, meters) { // flache Näherung, reicht für < 20 km
  const b = rad(bearingDeg);
  return { lat: p.lat + meters * Math.cos(b) / 110540, lon: p.lon + meters * Math.sin(b) / (111320 * Math.cos(rad(p.lat))) };
}
function xy(p, ref) { return [(p.lon - ref.lon) * 111320 * Math.cos(rad(ref.lat)), (p.lat - ref.lat) * 110540]; }
function unxy(v, ref) { return { lat: ref.lat + v[1] / 110540, lon: ref.lon + v[0] / (111320 * Math.cos(rad(ref.lat))) }; }
function vel(sogKn, cog) { if (sogKn == null || cog == null) return [0, 0]; const v = sogKn * KN; return [v * Math.sin(rad(cog)), v * Math.cos(rad(cog))]; }
function cpa(own, t) { // → {cpa (m), tcpa (s)}
  const d = xy(t, own), vo = vel(own.sog, own.cog), vt = vel(t.s, t.c);
  const v = [vt[0] - vo[0], vt[1] - vo[1]], vv = v[0] * v[0] + v[1] * v[1];
  if (vv < 1e-4) return { cpa: Math.hypot(d[0], d[1]), tcpa: 0 };
  const tc = -(d[0] * v[0] + d[1] * v[1]) / vv;
  return { cpa: Math.hypot(d[0] + v[0] * tc, d[1] + v[1] * tc), tcpa: tc };
}
const de = (n, d = 1) => n == null || !isFinite(n) ? '—' : n.toFixed(d).replace('.', ',');
const pad3 = (n) => n == null ? '—' : String(Math.round(n) % 360).padStart(3, '0');
function dm(v, isLat) {
  const h = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W'); v = Math.abs(v);
  let d = Math.floor(v), m = (v - d) * 60; if (m >= 59.9995) { d++; m = 0; }
  return `${String(d).padStart(isLat ? 2 : 3, '0')}°${m.toFixed(3).padStart(6, '0').replace('.', ',')}′${h}`;
}
const fmtPos = (p) => `${dm(p.lat, true)}  ${dm(p.lon, false)}`;
function fmtAge(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Schiffstypen ---------- */
const CAT = {
  cargo: ['#2e9e44', 'Frachter'], tanker: ['#d7263d', 'Tanker'], pass: ['#1f6fd1', 'Passagier/Fähre'],
  hsc: ['#e2b714', 'Schnellfähre'], fish: ['#e8862a', 'Fischerei'], sail: ['#8e44ad', 'Segler'],
  pleas: ['#d63ad6', 'Sportboot'], spec: ['#0fa3a3', 'Schlepper/Lotse/Behörde'], other: ['#7f8c99', 'Sonstige'],
  unk: ['#aab2bb', 'Unbekannt'],
};
function cat(ty) {
  const t = +ty || 0;
  if (t >= 70 && t <= 79) return 'cargo'; if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return 'pass'; if (t >= 40 && t <= 49) return 'hsc';
  if (t === 30) return 'fish'; if (t === 36) return 'sail'; if (t === 37) return 'pleas';
  if ([31, 32, 33, 34, 35, 50, 51, 52, 53, 54, 55, 58].includes(t)) return 'spec';
  return t ? 'other' : 'unk';
}
const TYPE_TXT = { 30: 'Fischereifahrzeug', 31: 'Schleppverband', 32: 'Schleppverband (groß)', 33: 'Baggerei/Unterwasserarbeit', 34: 'Taucharbeiten', 35: 'Militär', 36: 'Segelfahrzeug', 37: 'Sportboot', 50: 'Lotsenfahrzeug', 51: 'Such- und Rettung', 52: 'Schlepper', 53: 'Hafenversorger', 54: 'Umweltschutz', 55: 'Behörde/Polizei', 58: 'Sanitätsfahrzeug', 59: 'Sonderfahrzeug' };
function typeTxt(ty) { const t = +ty || 0; return TYPE_TXT[t] || (t ? `${CAT[cat(t)][1]} (${t})` : 'unbekannt'); }
const NAVST = ['unter Maschine', 'vor Anker', 'manövrierunfähig', 'manövrierbehindert', 'tiefgangbehindert', 'festgemacht', 'auf Grund', 'beim Fischen', 'unter Segel', '', '', 'schleppt (achteraus)', 'schiebt/schleppt längsseits', '', 'AIS-SART/Notfall', ''];

/* ---------- Karte ---------- */
const view = load('sk_view', { lat: 54.2, lon: 9.6, z: 11 });
const map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: false, worldCopyJump: true, tap: true, zoomSnap: 0.5 })
  .setView([view.lat, view.lon], view.z);
map.attributionControl.setPrefix(false);
const canvas = L.canvas({ padding: 0.3 });

const L_osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'base', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
const L_sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 18, className: 'base', attribution: 'Satellit © Esri' });
const L_depth = L.tileLayer.wms('https://ows.emodnet-bathymetry.eu/wms', { layers: 'emodnet:mean', styles: '', format: 'image/png', transparent: true, opacity: 0.5, className: 'base', attribution: 'Tiefen © EMODnet' });
const L_contour = L.tileLayer.wms('https://ows.emodnet-bathymetry.eu/wms', { layers: 'emodnet:contours', styles: '', format: 'image/png', transparent: true, opacity: 0.9, className: 'base' });
const L_sea = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 18, className: 'sea', attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>' });

function applyLayers() {
  const want = [[L_osm, !S.sat], [L_sat, S.sat], [L_depth, S.depth], [L_contour, S.depth], [L_sea, S.seamarks]];
  for (const [l, on] of want) { if (on && !map.hasLayer(l)) l.addTo(map); if (!on && map.hasLayer(l)) map.removeLayer(l); }
  L_sea.bringToFront();
  ownTrackLine.setStyle({ opacity: S.track ? 0.85 : 0 });
  drawRings(); updateLabels();
}

/* ---------- Zustand ---------- */
const ships = new Map();          // mmsi → Ziel
const statics = load('sk_static', {}); // Stammdaten-Cache (Name/Typ/Maße), überlebt Neustart
let gps = null, gpsHist = [], own = null, lastOwn = null, follow = true, selected = null;
let aisState = { state: 'off', detail: '' };
let measuring = false, measurePts = [], measureLayer = L.layerGroup().addTo(map);

/* ---------- Eigenes Schiff ---------- */
const ownLayer = L.layerGroup().addTo(map);
const ownTrackLine = L.polyline([], { renderer: canvas, color: '#f0731e', weight: 2.5, opacity: 0.85, dashArray: '1 5', lineCap: 'round', interactive: false }).addTo(map);
const ownAcc = L.circle([0, 0], { radius: 1, renderer: canvas, color: '#f0731e', weight: 1, fillOpacity: 0.08, interactive: false });
const ownVec = L.polyline([], { renderer: canvas, color: '#f0731e', weight: 3, interactive: false });
const ownHdg = L.polyline([], { renderer: canvas, color: '#f0731e', weight: 1, dashArray: '6 6', interactive: false });
const gpsDot = L.circleMarker([0, 0], { renderer: canvas, radius: 4, color: '#fff', weight: 1.5, fillColor: '#1f6fd1', fillOpacity: 1, interactive: false });
const aisDot = L.circleMarker([0, 0], { renderer: canvas, radius: 4, color: '#fff', weight: 1.5, fillColor: '#2e9e44', fillOpacity: 1, interactive: false });
const ownMarker = L.marker([0, 0], { icon: L.divIcon({ className: 'vessel', html: '<svg width="40" height="40" viewBox="-20 -20 40 40"><g id="ownRot"><path d="M0-17 10 13 0 7-10 13Z" fill="#f0731e" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></g></svg>', iconSize: [40, 40], iconAnchor: [20, 20] }), zIndexOffset: 1000, keyboard: false });
ownMarker.on('click', () => { if (S.mmsi && ships.get(+S.mmsi)) select(+S.mmsi); });
const ringLayer = L.layerGroup().addTo(map);
let ownTrack = [];

function startGps() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 30, t: Date.now(),
      sog: c.speed != null && c.speed >= 0 ? c.speed / KN : null, cog: c.heading != null && !isNaN(c.heading) ? c.heading : null };
    gpsHist.push({ lat: gps.lat, lon: gps.lon, t: gps.t }); if (gpsHist.length > 40) gpsHist.shift();
    gpsErr = '';
  }, (e) => { gpsErr = e.code === 1 ? 'Standort verweigert' : 'kein GPS-Signal'; }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}
let gpsErr = '';
function gpsMotion() { // Fahrt/Kurs aus Positionsverlauf, falls das Tablet keine liefert
  const now = Date.now(), h = gpsHist.filter((p) => now - p.t < 30000);
  if (h.length < 2) return {};
  const a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000;
  if (dt < 5) return {};
  const d = distM(a, b), sog = d / dt / KN;
  return { sog, cog: d > 8 ? brg(a, b) : null };
}

function fuse() {
  const now = Date.now(), cands = [];
  // Liegt das Tablet still, meldet der Browser oft keine neue Position → bis 5 min gültig, Unsicherheit wächst
  if (S.source !== 'ais' && gps && now - gps.t < 300000) {
    const m = gpsMotion(), moving = (gps.sog ?? m.sog ?? 0) > 1;
    cands.push({ k: 'GPS', lat: gps.lat, lon: gps.lon, sig: Math.max(gps.acc, 3) + (now - gps.t) / 1000 * (moving ? 5 : 0.3),
      sog: gps.sog ?? m.sog ?? null, cog: gps.cog ?? m.cog ?? null, hdg: null, age: now - gps.t });
  }
  const oa = S.mmsi ? ships.get(+S.mmsi) : null;
  if (S.source !== 'gps' && oa) {
    const age = (now - oa.ts) / 1000;
    if (age < 600) {
      const dr = oa.s > 0.3 && oa.c != null ? move({ lat: oa.la, lon: oa.lo }, oa.c, oa.s * KN * Math.min(age, 120)) : { lat: oa.la, lon: oa.lo };
      cands.push({ k: 'AIS', lat: dr.lat, lon: dr.lon, sig: 10 + (oa.s > 0.5 ? 1.2 : 0.05) * age, sog: oa.s ?? null, cog: oa.c ?? null, hdg: oa.h ?? null, age: age * 1000 });
    }
  }
  if (S.demo && !cands.length && demoOwn) cands.push({ k: 'DEMO', ...demoOwn, sig: 5, hdg: demoOwn.cog, age: 0 });
  if (!cands.length) { own = null; return; }
  let p;
  if (cands.length === 1) p = { ...cands[0], src: cands[0].k };
  else {
    const ref = cands[0]; let sx = 0, sy = 0, sw = 0;
    for (const c of cands) { const w = 1 / (c.sig * c.sig), v = xy(c, ref); sx += v[0] * w; sy += v[1] * w; sw += w; }
    const g = cands.find((c) => c.k === 'GPS'), a = cands.find((c) => c.k === 'AIS');
    const aFresh = a && a.age < 60000;
    p = { ...unxy([sx / sw, sy / sw], ref), sig: Math.sqrt(1 / sw), src: 'GPS+AIS',
      sog: aFresh ? a.sog : g.sog ?? a.sog, cog: aFresh ? a.cog : g.cog ?? a.cog, hdg: a.hdg,
      diff: distM(g, a), wG: Math.round(100 * (1 / g.sig ** 2) / sw) };
  }
  p.t = now; own = p; lastOwn = p;
}

function drawOwn() {
  const now = Date.now();
  if (!own) { [ownMarker, ownAcc, ownVec, ownHdg, gpsDot, aisDot].forEach((l) => ownLayer.removeLayer(l)); return; }
  const ll = [own.lat, own.lon];
  ownMarker.setLatLng(ll); ownAcc.setLatLng(ll).setRadius(Math.max(own.sig || 5, 3));
  for (const l of [ownAcc, ownVec, ownHdg, ownMarker]) if (!ownLayer.hasLayer(l)) ownLayer.addLayer(l);
  const dir = own.hdg ?? own.cog ?? 0;
  const el = ownMarker.getElement()?.querySelector('#ownRot'); if (el) el.setAttribute('transform', `rotate(${dir})`);
  if (own.sog > 0.3 && own.cog != null) ownVec.setLatLngs([ll, move(own, own.cog, own.sog * KN * S.vecMin * 60)]); else ownVec.setLatLngs([]);
  ownHdg.setLatLngs(own.hdg != null ? [ll, move(own, own.hdg, 3 * NM)] : []);
  // Rohquellen als Punkte, wenn kombiniert wird
  const showRaw = own.src === 'GPS+AIS';
  if (showRaw) {
    gpsDot.setLatLng([gps.lat, gps.lon]); const oa = ships.get(+S.mmsi); aisDot.setLatLng([oa.la, oa.lo]);
    ownLayer.addLayer(gpsDot); ownLayer.addLayer(aisDot);
  } else { ownLayer.removeLayer(gpsDot); ownLayer.removeLayer(aisDot); }
  // Track
  const last = ownTrack[ownTrack.length - 1];
  if (!last || (now - last.t > 5000 && distM(last, own) > 8)) {
    ownTrack.push({ lat: own.lat, lon: own.lon, t: now });
    while (ownTrack.length && now - ownTrack[0].t > 3 * 3600e3) ownTrack.shift();
    ownTrackLine.setLatLngs(ownTrack.map((p) => [p.lat, p.lon]));
  }
  if (follow) {
    const pt = map.latLngToContainerPoint(ll), c = map.getSize().divideBy(2);
    if (pt.distanceTo(c) > 4) map.panTo(ll, { animate: true, duration: 0.6, noMoveStart: true });
  }
}

function ringSet() { const z = map.getZoom(); return z >= 15 ? [0.1, 0.25, 0.5] : z >= 13 ? [0.25, 0.5, 1] : z >= 11 ? [0.5, 1, 2] : z >= 9 ? [2, 4, 8] : [5, 10, 20]; }
let ringKey = '';
function drawRings() {
  const p = own || lastOwn;
  const key = S.rings && p ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${map.getZoom()}` : '';
  if (key === ringKey) return; ringKey = key; ringLayer.clearLayers();
  if (!key) return;
  for (const r of ringSet()) {
    L.circle([p.lat, p.lon], { radius: r * NM, renderer: canvas, color: '#f0731e', weight: 1, opacity: 0.6, fill: false, dashArray: '4 6', interactive: false }).addTo(ringLayer);
    const lp = move(p, 0, r * NM);
    L.marker([lp.lat, lp.lon], { icon: L.divIcon({ className: 'ringlbl', html: `${de(r, r < 1 ? 2 : 0).replace(/,?0+$/, '')} sm`, iconSize: [50, 14], iconAnchor: [-4, 14] }), interactive: false, keyboard: false }).addTo(ringLayer);
  }
}

/* ---------- AIS-Ziele ---------- */
const shipLayer = L.layerGroup().addTo(map);
function upsert(o) {
  const m = +o.m; if (!m) return;
  let t = ships.get(m);
  if (!t) {
    t = { m, ...(statics[m] || {}), trk: [] };
    ships.set(m, t);
  }
  if (o.k === 'p') {
    if (t.la != null && (o.ts < t.ts)) return; // veraltete Meldung
    Object.assign(t, { la: o.la, lo: o.lo, s: o.s, c: o.c, h: o.h, ts: Math.min(o.ts || Date.now(), Date.now()), b: o.b });
    if (o.st != null) t.st = o.st; if (o.r != null) t.r = o.r;
    if (o.n && !t.n) t.n = o.n;
    if (o.ty) t.ty = o.ty; if (o.A != null && o.A + o.B > 0) Object.assign(t, { A: o.A, B: o.B, C: o.C, D: o.D });
    const lp = t.trk[t.trk.length - 1];
    if (!lp || Date.now() - lp.t > 20000) { t.trk.push({ lat: o.la, lon: o.lo, t: Date.now() }); if (t.trk.length > 90) t.trk.shift(); }
  } else if (o.k === 's') {
    for (const k of ['n', 'cs', 'imo', 'ty', 'dst', 'dr', 'eta']) if (o[k] != null && o[k] !== '' && o[k] !== 0) t[k] = o[k];
    if (o.A != null && o.A + o.B > 0) Object.assign(t, { A: o.A, B: o.B, C: o.C, D: o.D });
    statics[m] = { n: t.n, cs: t.cs, imo: t.imo, ty: t.ty, dst: t.dst, dr: t.dr, A: t.A, B: t.B, C: t.C, D: t.D };
    staticsDirty = true;
  }
}
let staticsDirty = false;
setInterval(() => {
  if (!staticsDirty) return; staticsDirty = false;
  const keys = Object.keys(statics); if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete statics[k]);
  store('sk_static', statics);
}, 30000);

function shipPos(t, now) { // kurze Koppelort-Hochrechnung (max. 30 s), damit sich Ziele flüssig bewegen
  const age = Math.min((now - t.ts) / 1000, 30);
  if (t.s > 0.5 && t.c != null && age > 0) return move({ lat: t.la, lon: t.lo }, t.c, t.s * KN * age);
  return { lat: t.la, lon: t.lo };
}

function iconHtml(t, danger, stale, sel) {
  const col = CAT[cat(t.ty)][0], moving = t.s >= 0.5;
  const sz = t.b ? 15 : 20, stroke = danger ? '#d7263d' : '#1b1b1b', sw = danger ? 3 : 1.2;
  const halo = sel ? `<circle r="${sz + 6}" fill="none" stroke="#1f6fd1" stroke-width="3"/>` : '';
  const ring = danger ? `<circle class="danger-ring" r="${sz + 9}" fill="none" stroke="#d7263d" stroke-width="3"/>` : '';
  let shape;
  if (moving || t.h != null) {
    const s = sz;
    shape = `<g class="rot"><path d="M0 ${-s}L${s * 0.55} ${s * 0.75}L0 ${s * 0.4}L${-s * 0.55} ${s * 0.75}Z" fill="${col}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/></g>`;
    if (!moving) shape = `<g class="rot"><path d="M0 ${-s * 0.8}L${s * 0.42} ${-s * 0.2}L${s * 0.42} ${s * 0.7}L${-s * 0.42} ${s * 0.7}L${-s * 0.42} ${-s * 0.2}Z" fill="${col}" stroke="${stroke}" stroke-width="${sw}"/></g>`;
  } else shape = `<circle r="${sz * 0.42}" fill="${col}" stroke="${stroke}" stroke-width="${sw}"/>`;
  const w = 2 * (sz + 12);
  return `<svg width="${w}" height="${w}" viewBox="${-w / 2} ${-w / 2} ${w} ${w}" style="opacity:${stale ? 0.4 : 1}">${ring}${halo}${shape}</svg>`;
}

function hullLatLngs(t, p) {
  const dir = t.h ?? t.c; if (dir == null || !(t.A + t.B > 0) || !(t.C + t.D > 0)) return null;
  const L_ = t.A + t.B, half = (t.C + t.D) / 2, off = (t.D - t.C) / 2; // Antenne → Rumpfmitte
  const pts = [[off, t.A], [off + half, t.A - Math.min(L_ * 0.18, 12)], [off + half, -t.B], [off - half, -t.B], [off - half, t.A - Math.min(L_ * 0.18, 12)]];
  const r = rad(dir), ref = { lat: p.lat, lon: p.lon };
  return pts.map(([x, y]) => { const ll = unxy([x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)], ref); return [ll.lat, ll.lon]; });
}

let dangers = [];
function renderShips() {
  const now = Date.now(), z = map.getZoom(), ownM = +S.mmsi;
  const newDangers = [];
  for (const [m, t] of ships) {
    if (t.la == null) continue;
    if (now - t.ts > DROP_MS) { removeShip(t); ships.delete(m); continue; }
    if (m === ownM && own) { removeShip(t); continue; }
    const p = shipPos(t, now), stale = now - t.ts > STALE_MS;
    t.p = p;
    if (own) { const c = cpa(own, { lat: p.lat, lon: p.lon, s: t.s, c: t.c }); t.cpa = c.cpa; t.tcpa = c.tcpa; t.dist = distM(own, p); t.brg = brg(own, p); }
    else { t.cpa = t.tcpa = t.dist = t.brg = null; }
    const danger = S.alarm && own && !stale && m !== ownM && t.tcpa > 0 && t.tcpa < S.tcpaMin * 60 && t.cpa < S.cpaNm * NM && (t.s > 0.5 || own.sog > 0.5);
    if (danger) newDangers.push(t);
    const sel = selected === m, key = `${cat(t.ty)}|${t.b}|${t.s >= 0.5}|${t.h != null}|${danger}|${stale}|${sel}`;
    if (!t.mk) {
      t.mk = L.marker([p.lat, p.lon], { keyboard: false, icon: L.divIcon({ className: 'vessel', html: iconHtml(t, danger, stale, sel), iconSize: [1, 1] }) });
      t.mk.on('click', (e) => { L.DomEvent.stopPropagation(e); select(m); });
      t.mk.bindTooltip('', { permanent: true, direction: 'right', offset: [14, 0], className: 'vlabel', interactive: false });
      t.key = key; t.mk.addTo(shipLayer);
    } else {
      t.mk.setLatLng([p.lat, p.lon]);
      if (t.key !== key) { t.key = key; t.mk.setIcon(L.divIcon({ className: 'vessel', html: iconHtml(t, danger, stale, sel), iconSize: [1, 1] })); }
    }
    const dir = t.h ?? t.c ?? 0, g = t.mk.getElement()?.querySelector('.rot'); if (g) g.setAttribute('transform', `rotate(${dir})`);
    t.mk.setZIndexOffset(danger ? 900 : sel ? 800 : t.b ? 0 : 100);
    // Kursvektor
    const vecOn = t.s >= 0.5 && t.c != null && !stale;
    if (vecOn) {
      const ll = [[p.lat, p.lon], (() => { const e = move(p, t.c, t.s * KN * S.vecMin * 60); return [e.lat, e.lon]; })()];
      if (!t.vec) t.vec = L.polyline(ll, { renderer: canvas, weight: 2, interactive: false }).addTo(shipLayer); else t.vec.setLatLngs(ll);
      t.vec.setStyle({ color: danger ? '#d7263d' : CAT[cat(t.ty)][0], opacity: 0.9 });
    } else if (t.vec) { shipLayer.removeLayer(t.vec); t.vec = null; }
    // Rumpf maßstabsgetreu bei starkem Zoom
    const hl = z >= 15 ? hullLatLngs(t, p) : null;
    if (hl) {
      if (!t.hull) { t.hull = L.polygon(hl, { renderer: canvas, weight: 1.2, color: '#1b1b1b', fillOpacity: 0.55 }).addTo(shipLayer); t.hull.on('click', (e) => { L.DomEvent.stopPropagation(e); select(m); }); }
      else t.hull.setLatLngs(hl);
      t.hull.setStyle({ fillColor: CAT[cat(t.ty)][0], color: danger ? '#d7263d' : '#1b1b1b' });
    } else if (t.hull) { shipLayer.removeLayer(t.hull); t.hull = null; }
    // Spur des ausgewählten Ziels
    if (sel && t.trk.length > 1) {
      const ll = t.trk.map((q) => [q.lat, q.lon]).concat([[p.lat, p.lon]]);
      if (!t.trkL) t.trkL = L.polyline(ll, { renderer: canvas, color: '#1f6fd1', weight: 2, dashArray: '2 5', interactive: false }).addTo(shipLayer); else t.trkL.setLatLngs(ll);
    } else if (t.trkL) { shipLayer.removeLayer(t.trkL); t.trkL = null; }
    // Name
    const label = t.n || String(m);
    if (t.lbl !== label) { t.lbl = label; t.mk.setTooltipContent(esc(label)); }
  }
  dangers = newDangers.sort((a, b) => a.tcpa - b.tcpa);
  updateLabels(); updateAlarm();
}
function removeShip(t) { for (const k of ['mk', 'vec', 'hull', 'trkL']) if (t[k]) { shipLayer.removeLayer(t[k]); t[k] = null; } t.key = null; }
let labelsShown = null;
function updateLabels() {
  const show = S.labels && map.getZoom() >= 12;
  for (const t of ships.values()) if (t.mk) { const tt = t.mk.getTooltip(); if (!tt) continue; if (show && !t.mk.isTooltipOpen()) t.mk.openTooltip(); if (!show && t.mk.isTooltipOpen()) t.mk.closeTooltip(); }
  labelsShown = show;
}

/* ---------- CPA-Alarm ---------- */
let audioCtx = null, ackSet = '', lastBeep = 0;
function beep() {
  if (!S.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.type = 'square'; g.gain.value = 0.0001;
      g.gain.setValueAtTime(0.18, t0 + i * 0.28); g.gain.setValueAtTime(0.0001, t0 + i * 0.28 + 0.16);
      o.connect(g).connect(audioCtx.destination); o.start(t0 + i * 0.28); o.stop(t0 + i * 0.28 + 0.2);
    }
  } catch (_) { /* kein Audio */ }
}
document.addEventListener('pointerdown', () => { // Audio + Wachhalten brauchen eine Berührung
  if (!audioCtx) try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /**/ }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  wake();
}, { passive: true });
function updateAlarm() {
  const el = $('#alarm');
  if (!dangers.length) { el.hidden = true; ackSet = ''; return; }
  const d = dangers[0];
  el.textContent = `⚠ ${d.n || d.m}: CPA ${de(d.cpa / NM, 2)} sm in ${Math.max(0, Math.round(d.tcpa / 60))} min${dangers.length > 1 ? `  (+${dangers.length - 1})` : ''}`;
  el.hidden = false;
  const set = dangers.map((x) => x.m).join(',');
  if (set !== ackSet && Date.now() - lastBeep > 8000) { lastBeep = Date.now(); beep(); }
}
$('#alarm').onclick = () => { ackSet = dangers.map((x) => x.m).join(','); if (dangers[0]) { select(dangers[0].m); map.panTo([dangers[0].p.lat, dangers[0].p.lon]); follow = false; syncFollow(); } };

/* ---------- AIS-Verbindung ---------- */
let ws = null, wsRetry = 1000, subBox = null, subTimer = null, hideTimer = null, pingTimer = null;
function wantBox() {
  const b = map.getBounds().pad(0.35);
  let s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  const p = own || lastOwn;
  if (p) { s = Math.min(s, p.lat - 0.12); n = Math.max(n, p.lat + 0.12); w = Math.min(w, p.lon - 0.2); e = Math.max(e, p.lon + 0.2); }
  const c = map.getCenter();
  if (n - s > 3) { s = c.lat - 1.5; n = c.lat + 1.5; }
  if (e - w > 5) { w = c.lng - 2.5; e = c.lng + 2.5; }
  return [[+s.toFixed(3), +w.toFixed(3)], [+n.toFixed(3), +e.toFixed(3)]];
}
function contains(a, b) { return a && b[0][0] >= a[0][0] && b[0][1] >= a[0][1] && b[1][0] <= a[1][0] && b[1][1] <= a[1][1]; }
const area = (b) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]);
function maybeSub(force) {
  if (!ws || ws.readyState !== 1) return;
  const want = wantBox();
  if (!force && contains(subBox, want) && area(subBox) < area(want) * 6) return;
  const box = [[want[0][0] - 0.05, want[0][1] - 0.08], [want[1][0] + 0.05, want[1][1] + 0.08]];
  subBox = box;
  const msg = { bbox: box }; if (S.key) msg.key = S.key;
  ws.send(JSON.stringify(msg));
}
function connect() {
  if (S.demo || ws || document.hidden) return;
  setAis('connecting');
  try { ws = new WebSocket(RELAY_URL); } catch (_) { ws = null; retry(); return; }
  ws.onopen = () => { wsRetry = 1000; subBox = null; maybeSub(true); clearInterval(pingTimer); pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"ping":1}'); }, 25000); };
  ws.onmessage = (ev) => {
    let o; try { o = JSON.parse(ev.data); } catch (_) { return; }
    if (o.k === 'status') { setAis(o.state, o.detail); return; }
    if (o.k === 'p' || o.k === 's') { upsert(o); lastMsg = Date.now(); if (aisState.state !== 'live') setAis('live'); }
  };
  ws.onclose = () => { ws = null; clearInterval(pingTimer); if (aisState.state !== 'nokey') setAis('offline'); retry(); };
  ws.onerror = () => { /* onclose folgt */ };
}
let lastMsg = 0;
function retry() { if (S.demo || document.hidden) return; clearTimeout(subTimer); subTimer = setTimeout(connect, aisState.state === 'nokey' ? 60000 : wsRetry); wsRetry = Math.min(wsRetry * 1.7, 30000); }
function disconnect() { clearTimeout(subTimer); if (ws) { const w = ws; ws = null; w.onclose = null; w.close(); } clearInterval(pingTimer); }
function setAis(state, detail = '') {
  if (state === 'error' && /key|schlüssel|api/i.test(detail)) state = 'nokey';
  if (state === 'upstream_closed' && /key|api/i.test(detail)) state = 'nokey';
  aisState = { state, detail };
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(hideTimer); hideTimer = setTimeout(disconnect, 60000); } // Verbindung freigeben (max. 3 je Account)
  else { clearTimeout(hideTimer); connect(); wake(); }
});
map.on('moveend', () => { maybeSub(false); const c = map.getCenter(); store('sk_view', { lat: c.lat, lon: c.lng, z: map.getZoom() }); });
map.on('zoomend', () => { drawRings(); renderShips(); });

/* ---------- Demo-Modus (ohne Internet/AIS-Key testen) ---------- */
let demoOwn = null, demoTimer = null;
function startDemo() {
  const c = own || lastOwn || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  demoOwn = gps ? null : { lat: c.lat, lon: c.lon, sog: 7, cog: 75 };
  const names = ['NORDLICHT', 'ELBE TRADER', 'KIELER BUCHT', 'ANNA MARIA', 'STENA GERMANICA', 'HOLSTENTOR', 'BRUNSBÜTTEL', 'SEEADLER', 'MARE NOSTRUM', 'FEHMARN', 'POLARIS', 'NIXE', 'LOTSE 3', 'SVEA', 'GORCH FOCK', 'OSTSEE', 'WIKING'];
  const tys = [70, 80, 60, 37, 69, 71, 52, 36, 79, 30, 84, 37, 50, 61, 36, 74, 0];
  const base = demoOwn || c;
  names.forEach((n, i) => {
    const p = move(base, (i * 47) % 360, (0.4 + (i % 6) * 0.45) * NM);
    const s = [0, 3, 6, 9, 11, 14][i % 6] + (i % 3);
    upsert({ k: 'p', m: 211000100 + i, la: p.lat, lo: p.lon, s, c: (i * 83) % 360, h: (i * 83) % 360, ts: Date.now(), b: tys[i] === 37 || tys[i] === 36 ? 1 : 0, n });
    upsert({ k: 's', m: 211000100 + i, n, ty: tys[i], cs: `DA${1000 + i}`, dst: ['KIEL', 'HAMBURG', 'BRUNSBUETTEL', 'ROSTOCK'][i % 4], A: 60 + i * 5, B: 20 + i, C: 7 + (i % 4), D: 7 + (i % 4), dr: 4 + (i % 5) });
  });
  // Ein Schiff auf Kollisionskurs, damit man die CPA-Warnung sieht
  const cp = move(base, 75, 1.2 * NM), cp2 = move(cp, 340, 1.0 * NM);
  upsert({ k: 'p', m: 211000999, la: cp2.lat, lo: cp2.lon, s: 9, c: 160, h: 160, ts: Date.now(), n: 'KOLLISIONSKURS' });
  upsert({ k: 's', m: 211000999, n: 'KOLLISIONSKURS', ty: 70, A: 120, B: 30, C: 10, D: 10 });
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    const now = Date.now();
    if (demoOwn) { const q = move(demoOwn, demoOwn.cog, demoOwn.sog * KN); demoOwn.lat = q.lat; demoOwn.lon = q.lon; }
    for (const t of ships.values()) if (t.m >= 211000100 && t.m <= 211000999 && now - t.ts > 2500) {
      const q = move({ lat: t.la, lon: t.lo }, t.c ?? 0, (t.s || 0) * KN * (now - t.ts) / 1000);
      if (t.m % 5 === 0 && t.c != null) { t.c = (t.c + 0.6) % 360; t.h = t.c; }
      upsert({ k: 'p', m: t.m, la: q.lat, lo: q.lon, s: t.s, c: t.c, h: t.h, ts: now, b: t.b });
    }
  }, 1000);
  setAis('demo');
}
function stopDemo() {
  clearInterval(demoTimer); demoOwn = null;
  for (const [m, t] of ships) if (m >= 211000100 && m <= 211000999) { removeShip(t); ships.delete(m); }
}

/* ---------- Kopfzeile ---------- */
function renderNav() {
  const p = own;
  $('#nPos').textContent = p ? fmtPos(p) : (lastOwn ? fmtPos(lastOwn) + ' (alt)' : 'keine Position');
  $('#nSog').textContent = p ? de(p.sog, 1) : '—';
  $('#nCog').textContent = p && p.cog != null && p.sog > 0.3 ? pad3(p.cog) : '—';
  $('#nHdg').textContent = p && p.hdg != null ? pad3(p.hdg) : '—';
  const src = $('#nSrc');
  if (p) { src.textContent = p.src === 'GPS+AIS' ? 'GPS + AIS' : p.src; src.className = 'badge ok'; src.title = `± ${Math.round(p.sig)} m`; }
  else { src.textContent = S.source === 'ais' && !S.mmsi ? 'MMSI fehlt' : gpsErr || 'suche…'; src.className = 'badge warn'; }
  const a = $('#nAis'), n = [...ships.values()].filter((t) => t.la != null && t.m !== +S.mmsi).length;
  const st = aisState.state;
  const fresh = Date.now() - lastMsg < 90000;
  if (st === 'demo') { a.textContent = `DEMO · ${n}`; a.className = 'badge warn'; }
  else if (st === 'nokey') { a.textContent = 'Schlüssel fehlt'; a.className = 'badge bad'; }
  else if (st === 'live' && fresh) { a.textContent = `live · ${n}`; a.className = 'badge ok'; }
  else if (st === 'live' || st === 'connecting' || st === 'relay') { a.textContent = n ? `verbinde · ${n}` : 'verbinde…'; a.className = 'badge warn'; }
  else { a.textContent = navigator.onLine === false ? 'offline' : 'getrennt'; a.className = 'badge bad'; }
  $('#nTime').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ---------- Auswahl / Detail ---------- */
function select(m) {
  const prev = selected; selected = m;
  for (const id of [prev, m]) { const t = ships.get(id); if (t) t.key = null; }
  if (panelMode) closePanel();
  renderShips(); renderSheet(); $('#sheet').hidden = false;
}
function closeSheet() { const t = ships.get(selected); selected = null; if (t) t.key = null; $('#sheet').hidden = true; renderShips(); }
function renderSheet() {
  if (selected == null || $('#sheet').hidden && selected == null) return;
  const t = ships.get(selected); if (!t) { closeSheet(); return; }
  const now = Date.now(), len = t.A + t.B, wid = t.C + t.D, isOwn = +S.mmsi === t.m;
  $('#sTitle').innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${CAT[cat(t.ty)][0]};margin-right:8px"></span>${esc(t.n || 'Unbekannt')}`;
  const eta = Array.isArray(t.eta) && t.eta[0] ? `${String(t.eta[1]).padStart(2, '0')}.${String(t.eta[0]).padStart(2, '0')}. ${String(t.eta[2]).padStart(2, '0')}:${String(t.eta[3]).padStart(2, '0')} UTC` : '—';
  const rows = [
    ['Fahrt', `${de(t.s, 1)} kn`, 'big'], ['Kurs (COG)', t.c != null ? `${pad3(t.c)}°` : '—', 'big'],
    ['Steuerkurs', t.h != null ? `${pad3(t.h)}°` : '—'], ['Status', NAVST[t.st] || '—'],
  ];
  if (!isOwn && t.dist != null) rows.push(['Abstand', `${de(t.dist / NM, 2)} sm`, 'big'], ['Peilung', `${pad3(t.brg)}°`],
    ['CPA', t.tcpa > 0 ? `${de(t.cpa / NM, 2)} sm` : 'läuft ab'], ['TCPA', t.tcpa > 0 ? `${de(t.tcpa / 60, 0)} min` : '—']);
  rows.push(['Typ', typeTxt(t.ty)], ['Ziel', esc(t.dst || '—')], ['ETA', eta], ['Größe', len > 0 ? `${len} × ${wid || '?'} m` : '—'],
    ['Tiefgang', t.dr ? `${de(t.dr, 1)} m` : '—'], ['MMSI', t.m], ['Rufzeichen', esc(t.cs || '—')], ['IMO', t.imo || '—'],
    ['AIS-Klasse', t.b ? 'B (klein)' : 'A'], ['Position', fmtPos({ lat: t.la, lon: t.lo })], ['Letzte Meldung', `vor ${fmtAge(now - t.ts)}`]);
  $('#sBody').innerHTML = `<dl class="kv">${rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c || ''}">${v}</dd>`).join('')}</dl>
    <div class="actions"><button class="btn pri" id="sCenter">Zentrieren</button>
    ${isOwn ? '<span class="small">Das ist dein eigenes Schiff.</span>' : `<button class="btn" id="sOwn">Als eigenes Schiff festlegen</button>`}</div>`;
  $('#sCenter').onclick = () => { follow = false; syncFollow(); map.setView([t.p?.lat ?? t.la, t.p?.lon ?? t.lo], Math.max(map.getZoom(), 14)); };
  const so = $('#sOwn'); if (so) so.onclick = () => { if (confirm(`„${t.n || t.m}" (MMSI ${t.m}) als eigenes Schiff verwenden?`)) { S.mmsi = String(t.m); save(); closeSheet(); } };
}

/* ---------- Panels ---------- */
let panelMode = null, panelTouch = 0;
$('#panel').addEventListener('pointerdown', () => { panelTouch = Date.now(); }, { passive: true });
$('#panel').addEventListener('scroll', () => { panelTouch = Date.now(); }, { passive: true, capture: true });
function openPanel(mode) {
  if (panelMode === mode) { closePanel(); return; }
  if (selected != null) closeSheet();
  panelMode = mode; $('#panel').hidden = false;
  for (const [id, m] of [['#bList', 'list'], ['#bLayers', 'layers'], ['#bSettings', 'settings']]) $(id).classList.toggle('on', m === mode);
  renderPanel(true);
}
function closePanel() { panelMode = null; $('#panel').hidden = true; ['#bList', '#bLayers', '#bSettings'].forEach((i) => $(i).classList.remove('on')); }
const sw = (id, on, label, hint = '') => `<div class="row"><label for="${id}">${label}${hint ? `<span class="hint">${hint}</span>` : ''}</label><span class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></span></div>`;
let listQuery = '';
function renderPanel(full) {
  const body = $('#pBody');
  if (panelMode === 'list') {
    if (full) { $('#pTitle').textContent = 'Schiffe in der Nähe'; body.innerHTML = `<input type="search" id="q" placeholder="Name oder MMSI suchen…" style="width:100%;margin:4px 0 8px" value="${esc(listQuery)}"><div id="ql"></div>`; $('#q').oninput = (e) => { listQuery = e.target.value; renderPanel(false); }; }
    const q = listQuery.trim().toUpperCase(), ownM = +S.mmsi;
    const arr = [...ships.values()].filter((t) => t.la != null && t.m !== ownM && (!q || (t.n || '').toUpperCase().includes(q) || String(t.m).includes(q)));
    arr.sort((a, b) => (a.dist ?? 1e12) - (b.dist ?? 1e12) || (a.n || '').localeCompare(b.n || ''));
    $('#ql').innerHTML = arr.length ? arr.slice(0, 250).map((t) => {
      const danger = dangers.includes(t);
      return `<div class="ship ${danger ? 'danger' : ''}" data-m="${t.m}"><span class="dot" style="background:${CAT[cat(t.ty)][0]}"></span>
      <div class="nm"><b>${esc(t.n || t.m)}</b><span>${typeTxt(t.ty)} · ${de(t.s, 1)} kn${t.dst ? ' · → ' + esc(t.dst) : ''}</span></div>
      <div class="ds">${t.dist != null ? de(t.dist / NM, 2) + ' sm' : '—'}<span>${t.tcpa > 0 && t.tcpa < 3600 ? 'CPA ' + de(t.cpa / NM, 2) + ' sm' : t.brg != null ? pad3(t.brg) + '°' : ''}</span></div></div>`;
    }).join('') : `<p class="small">${aisState.state === 'nokey' ? 'Kein AIS-Schlüssel hinterlegt – siehe Setup.' : 'Noch keine Schiffe empfangen.'}</p>`;
    if (full) $('#ql').onclick = (e) => { // Delegation: Liste wird laufend neu gezeichnet
      const el = e.target.closest('.ship'); if (!el) return; const t = ships.get(+el.dataset.m); if (!t) return;
      closePanel(); select(t.m); follow = false; syncFollow(); map.panTo([t.p?.lat ?? t.la, t.p?.lon ?? t.lo]);
    };
  } else if (panelMode === 'layers' && full) {
    $('#pTitle').textContent = 'Karte';
    body.innerHTML = `<div class="sec">Grundkarte</div>
      <div class="row"><div class="seg" id="segBase"><button data-v="0" class="${!S.sat ? 'on' : ''}">Seekarte</button><button data-v="1" class="${S.sat ? 'on' : ''}">Satellit</button></div></div>
      <div class="sec">Ebenen</div>
      ${sw('lSea', S.seamarks, 'Seezeichen (OpenSeaMap)', 'Tonnen, Leuchtfeuer, Fahrwasser, Häfen')}
      ${sw('lDepth', S.depth, 'Wassertiefen + Tiefenlinien', 'EMODnet – grob, nur zur Orientierung')}
      ${sw('lRings', S.rings, 'Abstandsringe um eigenes Schiff')}
      ${sw('lLabels', S.labels, 'Schiffsnamen anzeigen', 'ab mittlerer Zoomstufe')}
      ${sw('lTrack', S.track, 'Eigenen Track zeigen', 'letzte 3 Stunden')}
      <div class="sec">Farben der Schiffe</div><div class="legend">${legendHtml()}</div>`;
    body.querySelectorAll('#segBase button').forEach((b) => b.onclick = () => { S.sat = b.dataset.v === '1'; save(); applyLayers(); renderPanel(true); });
    const bind = (id, k) => { $(id).onchange = (e) => { S[k] = e.target.checked; save(); applyLayers(); }; };
    bind('#lSea', 'seamarks'); bind('#lDepth', 'depth'); bind('#lRings', 'rings'); bind('#lLabels', 'labels'); bind('#lTrack', 'track');
  } else if (panelMode === 'settings') {
    if (full) {
      $('#pTitle').textContent = 'Setup';
      body.innerHTML = `<div class="sec">Positionsquelle eigenes Schiff</div>
        <div class="row"><div class="seg" id="segSrc">${[['gps', 'GPS (Tablet)'], ['ais', 'AIS (Schiff)'], ['fused', 'Kombiniert']].map(([v, l]) => `<button data-v="${v}" class="${S.source === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="row"><label for="iMmsi">MMSI eigenes Schiff<span class="hint">9 Ziffern – nötig für „AIS" und „Kombiniert"</span></label><input type="text" id="iMmsi" inputmode="numeric" maxlength="9" style="width:150px" value="${esc(S.mmsi)}" placeholder="211…"></div>
        <div id="srcInfo" class="small" style="padding:6px 0"></div>
        <div class="sec">Kursvektoren & Warnung</div>
        <div class="row"><label for="iVec">Vektorlänge<span class="hint">Linie vor jedem Schiff = Weg in X Minuten</span></label><input type="number" id="iVec" min="1" max="60" value="${S.vecMin}"> min</div>
        ${sw('iAlarm', S.alarm, 'CPA-Warnung')}
        <div class="row"><label for="iCpa">Warnen unter CPA</label><input type="number" id="iCpa" min="0.05" max="5" step="0.05" value="${S.cpaNm}"> sm</div>
        <div class="row"><label for="iTcpa">…innerhalb von TCPA</label><input type="number" id="iTcpa" min="1" max="60" value="${S.tcpaMin}"> min</div>
        ${sw('iSound', S.sound, 'Warnton')}
        <div class="sec">Gerät</div>
        ${sw('iWake', S.wake, 'Bildschirm anlassen', 'solange die Seite offen ist')}
        <div class="row"><button class="btn" id="bFull">Vollbild</button><button class="btn" id="bClearTrack">Track löschen</button></div>
        <div class="sec">AIS-Verbindung</div>
        <div id="aisInfo" class="small" style="padding:4px 0 8px"></div>
        <div class="row"><label for="iKey">aisstream.io-Schlüssel<span class="hint">nur nötig, wenn er nicht schon auf dem Server hinterlegt ist</span></label><input type="text" id="iKey" style="width:170px" value="${esc(S.key)}" placeholder="optional" autocomplete="off" spellcheck="false"></div>
        ${sw('iDemo', S.demo, 'Demo-Modus', 'erfundene Schiffe zum Ausprobieren – NICHT echt')}
        <div class="row"><span class="small">Version 1.0 · Daten bleiben nur auf diesem Gerät gespeichert.</span></div>`;
      body.querySelectorAll('#segSrc button').forEach((b) => b.onclick = () => { S.source = b.dataset.v; save(); renderPanel(true); });
      $('#iMmsi').onchange = (e) => { const v = e.target.value.replace(/\D/g, ''); if (v && v.length !== 9) { alert('Eine MMSI hat genau 9 Ziffern.'); e.target.value = S.mmsi; return; } S.mmsi = v; save(); };
      const num = (id, k, min, max) => { $(id).onchange = (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (isFinite(v)) { S[k] = Math.min(max, Math.max(min, v)); save(); } e.target.value = S[k]; }; };
      num('#iVec', 'vecMin', 1, 60); num('#iCpa', 'cpaNm', 0.05, 5); num('#iTcpa', 'tcpaMin', 1, 60);
      $('#iAlarm').onchange = (e) => { S.alarm = e.target.checked; save(); };
      $('#iSound').onchange = (e) => { S.sound = e.target.checked; save(); if (S.sound) beep(); };
      $('#iWake').onchange = (e) => { S.wake = e.target.checked; save(); wake(); };
      $('#iKey').onchange = (e) => { S.key = e.target.value.trim(); save(); disconnect(); wsRetry = 1000; aisState = { state: 'off' }; connect(); };
      $('#iDemo').onchange = (e) => { S.demo = e.target.checked; save(); if (S.demo) { disconnect(); startDemo(); } else { stopDemo(); aisState = { state: 'off' }; connect(); } };
      $('#bFull').onclick = () => { const d = document.documentElement; (d.requestFullscreen || d.webkitRequestFullscreen)?.call(d); };
      $('#bClearTrack').onclick = () => { ownTrack = []; ownTrackLine.setLatLngs([]); };
    }
    const g = gps && Date.now() - gps.t < 300000, oa = S.mmsi ? ships.get(+S.mmsi) : null, oaFresh = oa && Date.now() - oa.ts < 600000;
    $('#srcInfo').innerHTML = `GPS Tablet: <b>${g ? `ok (± ${Math.round(gps.acc)} m)` : gpsErr || 'kein Signal'}</b><br>AIS eigenes Schiff: <b>${!S.mmsi ? 'keine MMSI eingetragen' : oaFresh ? `ok (${esc(oa.n || S.mmsi)}, vor ${fmtAge(Date.now() - oa.ts)})` : 'noch nicht empfangen'}</b>` +
      (own && own.src === 'GPS+AIS' ? `<br>Abstand GPS ↔ AIS: <b>${de(own.diff, 0)} m</b> · Gewicht GPS ${own.wG} % / AIS ${100 - own.wG} %` : '');
    $('#aisInfo').innerHTML = { live: 'Verbunden – Schiffe kommen live rein.', nokey: '<b style="color:var(--warn)">Kein gültiger aisstream.io-Schlüssel.</b> Ohne Schlüssel keine echten Schiffe.', demo: 'Demo läuft – die Schiffe sind erfunden.', offline: 'Keine Verbindung (Internet?). Versuche es automatisch erneut.' }[aisState.state] || 'Verbinde…';
  }
}
function legendHtml() {
  return Object.values(CAT).map(([c, l]) => `<div><svg viewBox="-12 -12 24 24"><path d="M0-10 6 8 0 4-6 8Z" fill="${c}" stroke="#1b1b1b" stroke-width="1"/></svg>${l}</div>`).join('') +
    `<div><svg viewBox="-12 -12 24 24"><path d="M0-10 6 8 0 4-6 8Z" fill="#f0731e" stroke="#fff" stroke-width="1.5"/></svg>Eigenes Schiff</div>`;
}
$('#legend').innerHTML = legendHtml();

/* ---------- Tag / Nacht ---------- */
const THEMES = ['day', 'dusk', 'night', 'auto'], THEME_TXT = { day: 'Tag', dusk: 'Dämmer.', night: 'Nacht', auto: 'Auto' };
function sunAlt(lat, lon, date) {
  const d = date / 86400000 - 10957.5, g = rad(357.529 + 0.98560028 * d), q = 280.459 + 0.98564736 * d;
  const Lm = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)), e = rad(23.439 - 3.6e-7 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(Lm), Math.cos(Lm)), dec = Math.asin(Math.sin(e) * Math.sin(Lm));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24) * 15, ha = rad(gmst + lon) - ra;
  return deg(Math.asin(Math.sin(rad(lat)) * Math.sin(dec) + Math.cos(rad(lat)) * Math.cos(dec) * Math.cos(ha)));
}
function applyTheme() {
  let t = S.theme;
  if (t === 'auto') { const p = own || lastOwn || { lat: map.getCenter().lat, lon: map.getCenter().lng }; const a = sunAlt(p.lat, p.lon, Date.now()); t = a > 0 ? 'day' : a > -6 ? 'dusk' : 'night'; }
  document.documentElement.dataset.theme = t;
  $('#themeLbl').textContent = THEME_TXT[S.theme];
  document.querySelector('meta[name=theme-color]').content = t === 'night' ? '#000000' : t === 'dusk' ? '#0e1621' : '#0b2236';
}
$('#bTheme').onclick = () => { S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]; save(); applyTheme(); };

/* ---------- Bedienelemente ---------- */
function syncFollow() { $('#bFollow').classList.toggle('on', follow); }
$('#bFollow').onclick = () => { follow = !follow; syncFollow(); const p = own || lastOwn; if (follow && p) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 12)); };
map.on('dragstart', () => { if (follow) { follow = false; syncFollow(); } });
$('#bList').onclick = () => openPanel('list');
$('#bLayers').onclick = () => openPanel('layers');
$('#bSettings').onclick = () => openPanel('settings');
$('#bHelp').onclick = () => { $('#help').hidden = false; };
document.querySelector('[data-close]').onclick = closePanel;
document.querySelector('[data-close-sheet]').onclick = closeSheet;
document.querySelector('[data-close-help]').onclick = () => { $('#help').hidden = true; S.helpSeen = true; save(); };
$('#help').onclick = (e) => { if (e.target.id === 'help') { $('#help').hidden = true; S.helpSeen = true; save(); } };
$('#zIn').onclick = () => map.zoomIn(1); $('#zOut').onclick = () => map.zoomOut(1);

$('#bMeasure').onclick = () => {
  measuring = !measuring; $('#bMeasure').classList.toggle('on', measuring);
  measurePts = []; measureLayer.clearLayers();
  $('#measureInfo').hidden = !measuring; $('#measureInfo').textContent = 'Punkte auf der Karte antippen…';
};
let cursorTimer = null;
map.on('click', (e) => {
  const p = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (measuring) {
    measurePts.push(p); measureLayer.clearLayers();
    L.polyline(measurePts.map((q) => [q.lat, q.lon]), { renderer: canvas, color: '#d7263d', weight: 3, dashArray: '8 6', interactive: false }).addTo(measureLayer);
    measurePts.forEach((q) => L.circleMarker([q.lat, q.lon], { renderer: canvas, radius: 6, color: '#d7263d', fillColor: '#fff', fillOpacity: 1, weight: 2, interactive: false }).addTo(measureLayer));
    let tot = 0; for (let i = 1; i < measurePts.length; i++) tot += distM(measurePts[i - 1], measurePts[i]);
    const n = measurePts.length;
    $('#measureInfo').innerHTML = n < 2 ? 'Nächsten Punkt antippen…' : `Gesamt <b>${de(tot / NM, 2)} sm</b> (${de(tot / 1000, 2)} km) · letzte Strecke ${pad3(brg(measurePts[n - 2], measurePts[n - 1]))}°`;
    return;
  }
  if (!$('#sheet').hidden) { closeSheet(); return; }
  const o = own || lastOwn;
  $('#cursorInfo').textContent = fmtPos(p) + (o ? `  ·  ${de(distM(o, p) / NM, 2)} sm / ${pad3(brg(o, p))}°` : '');
  clearTimeout(cursorTimer); cursorTimer = setTimeout(() => { $('#cursorInfo').textContent = ''; }, 8000);
});

/* ---------- Bildschirm wach halten ---------- */
let wakeLock = null;
async function wake() {
  if (!S.wake) { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } return; }
  if (wakeLock || document.hidden || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (_) { /* braucht Berührung */ }
}

/* ---------- Hauptschleife ---------- */
function tick() {
  fuse(); drawOwn(); renderShips(); drawRings(); renderNav();
  // Nicht neu zeichnen, während der Finger auf dem Panel ist (sonst gehen Tipps verloren)
  if ((panelMode === 'list' || panelMode === 'settings') && Date.now() - panelTouch > 1500 && !(panelMode === 'settings' && document.activeElement?.tagName === 'INPUT')) renderPanel(false);
  if (selected != null && !$('#sheet').hidden) renderSheet();
}
let themeTick = 0;
setInterval(() => { tick(); if (++themeTick % 60 === 0 && S.theme === 'auto') applyTheme(); if (themeTick % 10 === 0) maybeSub(false); }, 1000);

applyTheme(); applyLayers(); syncFollow(); startGps();
if (S.demo) startDemo(); else connect();
if (!S.helpSeen) $('#help').hidden = false;
setTimeout(() => { fuse(); const p = own; if (p && follow) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 12)); }, 2500);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
tick();
