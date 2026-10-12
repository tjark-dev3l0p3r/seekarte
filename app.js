/* Seekarte Live 2 — MapLibre-Vektorseekarte (S-52-ähnliche Tag/Dämmerung/Nacht-Farbtafeln) + Live-AIS.
   Eigene Position: Tablet-GPS, eigenes AIS (MMSI) oder gewichtetes Mittel aus beidem. */
'use strict';

const VERSION = '2.2.0';
const RELAY_URL = 'wss://twybfsbfbxvwwxbdphum.supabase.co/functions/v1/ais-relay';
const NM = 1852, KN = 1852 / 3600;
const STALE_MS = 6 * 60e3, DROP_MS = 20 * 60e3;
const $ = (s) => document.querySelector(s);

/* ================= Einstellungen ================= */
const DEFAULTS = {
  mmsi: '', source: 'fused', key: '', vecMin: 6, cpaNm: 0.5, tcpaMin: 15, alarm: true, sound: true,
  theme: 'day', orient: 'north', seamarks: true, depth: false, sat: false, rings: true, labels: true, track: true,
  showB: true, showMoored: true, demo: false, wake: true, onboarded: false, units: 'sea', profile: 'sea', mob: null, depthPts: true, tideStrip: true, draught: 0, ukc: 0.5,
};
// Warn-Profile: Abstand (sm) / Vorwarnzeit (min) – im Kanal passieren sich Schiffe planmäßig auf ~50–100 m
const PROFILES = { sea: { cpa: 0.5, tcpa: 15, t: 'See' }, river: { cpa: 0.2, tcpa: 10, t: 'Revier / Elbe' }, canal: { cpa: 0.03, tcpa: 4, t: 'Kanal' } };
function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* privat/voll */ } }
const S = Object.assign({}, DEFAULTS, load('sk_settings', {}));
let pendingShip = null; // aus geteiltem Link #ship=MMSI
if (load('sk_settings', {}).helpSeen) S.onboarded = true; // v1-Nutzer nicht erneut durch den Assistenten schicken
const save = () => store('sk_settings', S);

// Einrichtung per Link: …/#mmsi=211234567&src=fused   (Hash geht nie an einen Server)
(function hashSetup() {
  if (!location.hash.includes('=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (/^\d{9}$/.test(p.get('mmsi') || '')) S.mmsi = p.get('mmsi');
  if (['gps', 'ais', 'fused'].includes(p.get('src'))) S.source = p.get('src');
  if ((p.get('key') || '').length >= 20) S.key = p.get('key');
  if (p.get('demo')) S.demo = p.get('demo') === '1';
  if (p.get('mmsi') || p.get('src')) S.onboarded = true;
  if (/^\d{9}$/.test(p.get('ship') || '')) pendingShip = +p.get('ship');
  save();
  history.replaceState(null, '', location.pathname + location.search);
})();

/* ================= Geo-Helfer ================= */
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
function move(p, bearingDeg, m) {
  const b = rad(bearingDeg);
  return { lat: p.lat + m * Math.cos(b) / 110540, lon: p.lon + m * Math.sin(b) / (111320 * Math.cos(rad(p.lat))) };
}
const xy = (p, r) => [(p.lon - r.lon) * 111320 * Math.cos(rad(r.lat)), (p.lat - r.lat) * 110540];
const unxy = (v, r) => ({ lat: r.lat + v[1] / 110540, lon: r.lon + v[0] / (111320 * Math.cos(rad(r.lat))) });
function vel(sog, cog) { if (sog == null || cog == null) return [0, 0]; const v = sog * KN; return [v * Math.sin(rad(cog)), v * Math.cos(rad(cog))]; }
function cpa(own, t) {
  const d = xy(t, own), vo = vel(own.sog, own.cog), vt = vel(t.s, t.c);
  const v = [vt[0] - vo[0], vt[1] - vo[1]], vv = v[0] * v[0] + v[1] * v[1];
  if (vv < 1e-4) return { cpa: Math.hypot(d[0], d[1]), tcpa: 0 };
  const tc = -(d[0] * v[0] + d[1] * v[1]) / vv;
  return { cpa: Math.hypot(d[0] + v[0] * tc, d[1] + v[1] * tc), tcpa: tc };
}
const ll = (p) => [p.lon, p.lat];
function circle(c, r, n = 72) { const out = []; for (let i = 0; i <= n; i++) out.push(ll(move(c, i * 360 / n, r))); return out; }
const de = (n, d = 1) => n == null || !isFinite(n) ? '–' : n.toFixed(d).replace('.', ',');
const p3 = (n) => n == null || !isFinite(n) ? '–' : String(Math.round(n) % 360).padStart(3, '0');
function dm(v, isLat, prec = 3) {
  const h = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W'); v = Math.abs(v);
  let d = Math.floor(v), m = (v - d) * 60; if (m >= 60 - 0.5 * 10 ** -prec) { d++; m = 0; }
  return `${String(d).padStart(isLat ? 2 : 3, '0')}°${m.toFixed(prec).padStart(prec + 3, '0').replace('.', ',')}′${h}`;
}
const fmtPos = (p) => `${dm(p.lat, true)}  ${dm(p.lon, false)}`;
function fmtAge(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Einheiten: See = kn/sm, Binnen/Kanal = km/h/km (NOK-Höchstgeschwindigkeit wird in km/h angegeben)
function nmTxt(m) {
  if (m == null || !isFinite(m)) return '–';
  if (S.units === 'inland') return m < 1000 ? `${Math.round(m / 5) * 5} m` : `${de(m / 1000, m < 10000 ? 2 : 1)} km`;
  return m < 185 ? `${Math.round(m / 5) * 5} m` : `${de(m / NM, m < NM ? 2 : m < 10 * NM ? 1 : 0)} sm`;
}
const spdU = () => S.units === 'inland' ? 'km/h' : 'kn';
const spd = (kn, d = 1) => kn == null || !isFinite(kn) ? '–' : de(S.units === 'inland' ? kn * 1.852 : kn, d);
function relSide(own, b) { // Seitenpeilung: "Stb 35°" / "Bb 120°" / "voraus"
  const dir = own && (own.hdg ?? (own.sog > 0.5 ? own.cog : null)); if (dir == null || b == null) return '';
  const r = ((b - dir + 540) % 360) - 180, a = Math.abs(Math.round(r));
  return a <= 3 ? 'recht voraus' : a >= 177 ? 'recht achteraus' : `${r > 0 ? 'Stb' : 'Bb'} ${a}°`;
}
// Flaggenstaat aus den ersten 3 MMSI-Ziffern (Auswahl der Fahrtgebiete Nord-/Ostsee)
const MID = { 211: 'Deutschland', 218: 'Deutschland', 219: 'Dänemark', 220: 'Dänemark', 244: 'Niederlande', 245: 'Niederlande', 246: 'Niederlande',
  205: 'Belgien', 226: 'Frankreich', 227: 'Frankreich', 228: 'Frankreich', 230: 'Finnland', 231: 'Färöer', 232: 'Großbritannien', 233: 'Großbritannien', 234: 'Großbritannien', 235: 'Großbritannien',
  236: 'Gibraltar', 209: 'Zypern', 210: 'Zypern', 212: 'Zypern', 215: 'Malta', 229: 'Malta', 248: 'Malta', 249: 'Malta', 256: 'Malta', 224: 'Spanien', 225: 'Spanien', 247: 'Italien',
  237: 'Griechenland', 239: 'Griechenland', 240: 'Griechenland', 241: 'Griechenland', 250: 'Irland', 251: 'Island', 253: 'Luxemburg', 255: 'Portugal (Madeira)', 257: 'Norwegen', 258: 'Norwegen', 259: 'Norwegen',
  261: 'Polen', 263: 'Portugal', 265: 'Schweden', 266: 'Schweden', 271: 'Türkei', 273: 'Russland', 275: 'Lettland', 276: 'Estland', 277: 'Litauen', 304: 'Antigua & Barbuda', 305: 'Antigua & Barbuda',
  308: 'Bahamas', 309: 'Bahamas', 311: 'Bahamas', 314: 'Barbados', 319: 'Cayman Islands', 351: 'Panama', 352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama',
  370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama', 378: 'Brit. Jungferninseln', 412: 'China', 413: 'China', 477: 'Hongkong', 538: 'Marshallinseln', 563: 'Singapur', 564: 'Singapur', 565: 'Singapur', 566: 'Singapur', 636: 'Liberia', 637: 'Liberia' };
const flag = (m) => MID[Math.floor(m / 1e6)] || '';
const isSart = (t) => t.st === 14 || /^97[024]/.test(String(t.m)); // AIS-SART / MOB-Sender / EPIRB-AIS
function rotTxt(r) { if (r == null) return '–'; if (Math.abs(r) >= 127) return r > 0 ? 'dreht nach Stb' : 'dreht nach Bb'; const v = Math.sign(r) * (r / 4.733) ** 2; return Math.abs(v) < 1 ? 'geradeaus' : `${Math.round(Math.abs(v))}°/min nach ${v > 0 ? 'Stb' : 'Bb'}`; }
const tz = () => new Intl.DateTimeFormat('de-DE', { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';

/* ================= Schiffstypen ================= */
const CATS = ['cargo', 'tanker', 'pass', 'hsc', 'fish', 'sail', 'pleas', 'spec', 'other', 'unk'];
const CAT_TXT = { cargo: 'Frachter', tanker: 'Tanker', pass: 'Fahrgast/Fähre', hsc: 'Schnellfahrzeug', fish: 'Fischerei', sail: 'Segler', pleas: 'Sportboot', spec: 'Schlepper/Lotse/Behörde', other: 'Sonstige', unk: 'Typ unbekannt' };
const CATCOL = { // gedämpft: Farbe trägt Information, schreit aber nicht (Rot bleibt der Gefahr vorbehalten)
  day: { cargo: '#5f9a6c', tanker: '#a4544f', pass: '#4f7db3', hsc: '#c39a2c', fish: '#b77c45', sail: '#8a76b2', pleas: '#ad6fa2', spec: '#3f9894', other: '#86919a', unk: '#b3bac0' },
  dusk: { cargo: '#7fb38c', tanker: '#c77a73', pass: '#7298c6', hsc: '#d4b259', fish: '#c99a6c', sail: '#a091c2', pleas: '#c48fba', spec: '#66b3ae', other: '#9aa4ac', unk: '#7c868e' },
  night: { cargo: '#4a1208', tanker: '#4a1208', pass: '#4a1208', hsc: '#4a1208', fish: '#4a1208', sail: '#4a1208', pleas: '#4a1208', spec: '#4a1208', other: '#3a0e06', unk: '#3a0e06' },
};
function cat(ty) {
  const t = +ty || 0;
  if (t >= 70 && t <= 79) return 'cargo'; if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return 'pass'; if (t >= 40 && t <= 49) return 'hsc';
  if (t === 30) return 'fish'; if (t === 36) return 'sail'; if (t === 37) return 'pleas';
  if ([31, 32, 33, 34, 35, 50, 51, 52, 53, 54, 55, 58].includes(t)) return 'spec';
  return t ? 'other' : 'unk';
}
const TYPE_TXT = { 30: 'Fischereifahrzeug', 31: 'Schleppverband', 32: 'Schleppverband (groß)', 33: 'Bagger/Unterwasserarbeit', 34: 'Taucharbeiten', 35: 'Marine', 36: 'Segelfahrzeug', 37: 'Sportboot', 50: 'Lotsenversetzer', 51: 'Such- und Rettungsfahrzeug', 52: 'Schlepper', 53: 'Hafenversorger', 54: 'Umweltschutzfahrzeug', 55: 'Behördenfahrzeug', 58: 'Sanitätsfahrzeug', 59: 'Sonderfahrzeug' };
function typeTxt(ty) { const t = +ty || 0; return TYPE_TXT[t] || (t ? CAT_TXT[cat(t)] : 'Typ noch unbekannt'); }
const NAVST = ['in Fahrt (Maschine)', 'vor Anker', 'manövrierunfähig', 'manövrierbehindert', 'tiefgangbehindert', 'festgemacht', 'festgekommen', 'fischt', 'in Fahrt (Segel)', '', '', 'schleppt achteraus', 'schiebt / schleppt längsseits', '', 'AIS-SART / Notfall', ''];
function etaTxt(e) { // AIS-ETA ist UTC ohne Jahr; 24 h / 60 min = nicht verfügbar
  if (!Array.isArray(e) || !e[0] || !e[1] || e[2] >= 24 || e[3] >= 60) return '–';
  const now = new Date(); let d = new Date(Date.UTC(now.getUTCFullYear(), e[0] - 1, e[1], e[2], e[3]));
  if (d - now < -180 * 864e5) d = new Date(Date.UTC(now.getUTCFullYear() + 1, e[0] - 1, e[1], e[2], e[3]));
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' ' + tz();
}

/* ================= Karten-Farbtafeln ================= */
const PAL = {
  day: { sndShoal: '#c8322f', sndWarn: '#c77a12', sndSafe: '#2f5f86', sndText: '#2b4a63', land: '#efe3b4', built: '#e3d39d', bldg: '#d3c188', water: '#d4e9f0', coast: '#4f5b5c', tidal: '#9fc4a6', wet: '#cfd9ac', green: '#e2d9a1', road: '#f8f0d3', roadc: '#cdbd8a', rail: '#9a9277', label: '#4a4434', wlabel: '#2a5870', halo: '#f6edc8', seaB: 1, seaS: 0, satB: 1,
    own: '#e2661b', ownLine: '#c4520f', ownHalo: '#ffffff', ink: '#0f2130', danger: '#d3263a', accent: '#a3246f', vec: '#26394a', tgtStroke: '#1b1f22', ring: '#a3246f', trk: '#c4520f', selTrk: '#2a6fd0', meas: '#a3246f', scaleInk: '#0f2130', scalePaper: '#ffffff' },
  dusk: { sndShoal: '#e5585a', sndWarn: '#d69a3a', sndSafe: '#6a9cc4', sndText: '#8fb1cc', land: '#3a3427', built: '#433c2d', bldg: '#4d4535', water: '#15232b', coast: '#9aa29b', tidal: '#2c4334', wet: '#323a29', green: '#373424', road: '#5a5242', roadc: '#2b271e', rail: '#5a5446', label: '#c1b796', wlabel: '#7fa6b8', halo: '#171c1f', seaB: .82, seaS: -.1, satB: .55,
    own: '#f08a3c', ownLine: '#f08a3c', ownHalo: '#0b1116', ink: '#d9ded6', danger: '#ef4054', accent: '#d267a8', vec: '#aebbc5', tgtStroke: '#05080a', ring: '#d267a8', trk: '#f08a3c', selTrk: '#6f9fe0', meas: '#d267a8', scaleInk: '#d9ded6', scalePaper: '#0b141a' },
  night: { sndShoal: '#ff3b1f', sndWarn: '#8a2a12', sndSafe: '#4d1409', sndText: '#5e1a0c', land: '#130e06', built: '#191208', bldg: '#20170b', water: '#020304', coast: '#5a3a20', tidal: '#15160a', wet: '#141309', green: '#151107', road: '#2f1e0e', roadc: '#120d06', rail: '#2a1c0d', label: '#8a3524', wlabel: '#6b291b', halo: '#030202', seaB: .36, seaS: -.35, satB: .22,
    own: '#b8691f', ownLine: '#9a5418', ownHalo: '#000000', ink: '#b83a28', danger: '#ff3b1f', accent: '#b83a28', vec: '#7a2416', tgtStroke: '#7a2416', ring: '#6b2216', trk: '#7a3f12', selTrk: '#7a2416', meas: '#b83a28', scaleInk: '#7a2416', scalePaper: '#000000' },
};

let theme = 'day'; // tatsächlich angezeigte Farbtafel (bei "auto" berechnet)
function baseStyle() {
  const c = PAL.day;
  const W = 'https://ows.emodnet-bathymetry.eu/wms?service=WMS&request=GetMap&version=1.1.1&layers=emodnet:mean&styles=atlas_land&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}';
  return {
    version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© <a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      sea: { type: 'raster', tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18, attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>' },
      sat: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: 'Satellit © Esri' },
      depth: { type: 'raster', tiles: [W], tileSize: 256, maxzoom: 14, attribution: 'Tiefen © EMODnet Bathymetry' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': c.land } },
      { id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['residential', 'commercial', 'industrial', 'retail', 'railway', 'quarry', 'garages']]], paint: { 'fill-color': c.built } },
      { id: 'green', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood', 'farmland']]], paint: { 'fill-color': c.green, 'fill-opacity': .35 } },
      { id: 'wet', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wetland'], paint: { 'fill-color': ['match', ['get', 'subclass'], ['tidalflat', 'saltmarsh'], c.tidal, c.wet] } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, .8, 16, 4] } },
      { id: 'depth', type: 'raster', source: 'depth', layout: { visibility: 'none' }, paint: { 'raster-opacity': .5 } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
      { id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': c.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, .4, 14, 1.1, 18, 1.6] } },
      { id: 'pier', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'pier'], paint: { 'line-color': c.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 18, 5] } },
      { id: 'bldg', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': c.bldg } },
      { id: 'roadc', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9, filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary']]], paint: { 'line-color': c.roadc, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.4, 16, 8] } },
      { id: 'road', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 9, filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']]], paint: { 'line-color': c.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, .5, 16, 5.5] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 10, filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': c.rail, 'line-width': 1, 'line-dasharray': [3, 2] } },
      { id: 'sea', type: 'raster', source: 'sea', paint: {} },
      { id: 'wname', type: 'symbol', source: 'omt', 'source-layer': 'water_name', layout: { 'text-field': ['coalesce', ['get', 'name:de'], ['get', 'name']], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 14], 'text-letter-spacing': .18, 'symbol-placement': ['step', ['zoom'], 'point', 11, 'line'], 'text-max-angle': 30 }, paint: { 'text-color': c.wlabel, 'text-halo-color': c.halo, 'text-halo-width': 1.3 } },
      { id: 'place', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb']]], layout: { 'text-field': ['coalesce', ['get', 'name:de'], ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'city', 16, 'town', 14, 11.5], 'text-transform': 'uppercase', 'text-letter-spacing': .1 }, paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.5 } },
    ],
  };
}

/* ================= Karte ================= */
const view = load('sk_view', { lat: 54.2, lon: 9.6, z: 11 });
const map = new maplibregl.Map({
  container: 'map', style: baseStyle(), center: [view.lon, view.lat], zoom: view.z, maxZoom: 18.5, minZoom: 3,
  attributionControl: false, pitchWithRotate: false, dragRotate: false, touchPitch: false, fadeDuration: 150,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'AIS: aisstream.io · Nicht zur Navigation' }), 'bottom-right');

/* ---------- Symbole als Bilder (pixelRatio 2) ---------- */
function canvasImg(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
  const g = c.getContext('2d'); g.scale(2, 2); g.translate(w / 2, h / 2); draw(g);
  return g.getImageData(0, 0, w * 2, h * 2);
}
function tri(g, s) { g.beginPath(); g.moveTo(0, -s); g.lineTo(s * .58, s * .78); g.lineTo(-s * .58, s * .78); g.closePath(); }
function iconSet(th) {
  const P = PAL[th], C = CATCOL[th], out = {};
  for (const k of CATS) for (const dg of [0, 1]) {
    const stroke = dg ? P.danger : P.tgtStroke, lw = dg ? 3 : 1.25;
    out[`mv-${k}-${dg}`] = canvasImg(40, 40, (g) => { tri(g, 13); g.fillStyle = C[k]; g.fill(); g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.stroke(); });
    out[`st-${k}-${dg}`] = canvasImg(40, 40, (g) => { tri(g, 9.5); g.fillStyle = C[k]; g.fill(); g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.stroke(); g.beginPath(); g.arc(0, 2, 1.6, 0, 7); g.fillStyle = stroke; g.fill(); });
    out[`ci-${k}-${dg}`] = canvasImg(40, 40, (g) => { g.beginPath(); g.arc(0, 0, 6, 0, 7); g.fillStyle = C[k]; g.fill(); g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); });
  }
  out.sel = canvasImg(56, 56, (g) => {
    g.strokeStyle = P.accent; g.lineWidth = 3; g.lineCap = 'round'; const a = 22, b = 9;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { g.beginPath(); g.moveTo(sx * a, sy * (a - b)); g.lineTo(sx * a, sy * a); g.lineTo(sx * (a - b), sy * a); g.stroke(); }
  });
  out.own = canvasImg(48, 48, (g) => {
    g.beginPath(); g.moveTo(0, -19); g.bezierCurveTo(7, -12, 8.5, -4, 8, 4); g.lineTo(7, 16); g.lineTo(-7, 16); g.lineTo(-8, 4); g.bezierCurveTo(-8.5, -4, -7, -12, 0, -19); g.closePath();
    g.fillStyle = P.own; g.fill(); g.lineWidth = 2.4; g.strokeStyle = P.ownHalo; g.lineJoin = 'round'; g.stroke();
    g.beginPath(); g.arc(0, 2, 2.6, 0, 7); g.fillStyle = P.ownHalo; g.fill();
  });
  out.ownc = canvasImg(36, 36, (g) => {
    g.beginPath(); g.arc(0, 0, 9, 0, 7); g.fillStyle = P.own; g.fill(); g.lineWidth = 2.4; g.strokeStyle = P.ownHalo; g.stroke();
    g.beginPath(); g.arc(0, 0, 2.6, 0, 7); g.fillStyle = P.ownHalo; g.fill();
  });
  out.mob = canvasImg(44, 44, (g) => {
    g.beginPath(); g.arc(0, 0, 15, 0, 7); g.fillStyle = P.danger; g.fill(); g.lineWidth = 2.5; g.strokeStyle = P.ownHalo; g.stroke();
    g.fillStyle = P.ownHalo; g.font = '800 11px Archivo, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('MOB', 0, 1);
  });
  return out;
}
let iconsReady = false;
function syncIcons() {
  const set = iconSet(theme);
  for (const [k, img] of Object.entries(set)) {
    if (map.hasImage(k)) map.updateImage(k, img); else map.addImage(k, img, { pixelRatio: 2 });
  }
  iconsReady = true;
}

/* ---------- Eigene Datenquellen + Ebenen ---------- */
const FC = (features = []) => ({ type: 'FeatureCollection', features });
function addOverlay() {
  for (const id of ['tgt', 'tgtl', 'owns', 'meas', 'snd']) map.addSource(id, { type: 'geojson', data: FC(), buffer: 64, tolerance: .2 });
  const P = PAL.day, iz = (f) => ['interpolate', ['linear'], ['zoom'], 6, ['*', .5 * f, ['get', 'sz']], 11, ['*', .78 * f, ['get', 'sz']], 14, ['*', 1 * f, ['get', 'sz']], 17, ['*', 1.25 * f, ['get', 'sz']]];
  const L = [
    { id: 'snd-dot', type: 'circle', source: 'snd', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 1.6, 15, 2.4], 'circle-color': ['match', ['get', 'c'], 'shoal', P.sndShoal, 'warn', P.sndWarn, P.sndSafe], 'circle-opacity': .9 } },
    { id: 'snd-lbl', type: 'symbol', source: 'snd', minzoom: 12.3, layout: { 'text-field': ['get', 't'], 'text-font': ['Noto Sans Italic'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12.3, 9.5, 16, 11.5], 'text-offset': [0, .75], 'text-padding': 1, 'text-allow-overlap': false }, paint: { 'text-color': ['match', ['get', 'c'], 'shoal', P.sndShoal, 'warn', P.sndWarn, P.sndText], 'text-halo-color': P.halo, 'text-halo-width': 1.1, 'text-opacity': .95 } },
    { id: 'own-acc', type: 'fill', source: 'owns', filter: ['==', ['get', 'k'], 'acc'], paint: { 'fill-color': P.own, 'fill-opacity': .1, 'fill-outline-color': P.own } },
    { id: 'own-trk', type: 'line', source: 'owns', filter: ['==', ['get', 'k'], 'trk'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': P.trk, 'line-width': 2.2, 'line-dasharray': [.5, 2.2], 'line-opacity': .9 } },
    { id: 'own-ring', type: 'line', source: 'owns', filter: ['==', ['get', 'k'], 'ring'], paint: { 'line-color': P.ring, 'line-width': 1, 'line-opacity': .65, 'line-dasharray': [4, 4] } },
    { id: 'own-rlbl', type: 'symbol', source: 'owns', filter: ['==', ['get', 'k'], 'rlbl'], layout: { 'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-anchor': 'bottom', 'text-offset': [0, -.2], 'text-allow-overlap': true }, paint: { 'text-color': P.ring, 'text-halo-color': P.halo, 'text-halo-width': 1.4 } },
    { id: 'hull', type: 'fill', source: 'tgtl', filter: ['==', ['get', 'k'], 'hull'], paint: { 'fill-color': ['get', 'col'], 'fill-opacity': .6 } },
    { id: 'hull-o', type: 'line', source: 'tgtl', filter: ['==', ['get', 'k'], 'hull'], paint: { 'line-color': ['case', ['==', ['get', 'dg'], 1], P.danger, P.tgtStroke], 'line-width': ['case', ['==', ['get', 'dg'], 1], 2.5, 1] } },
    { id: 'sel-trk', type: 'line', source: 'tgtl', filter: ['==', ['get', 'k'], 'trk'], layout: { 'line-cap': 'round' }, paint: { 'line-color': P.selTrk, 'line-width': 2, 'line-dasharray': [.6, 2] } },
    { id: 'cpa', type: 'line', source: 'tgtl', filter: ['==', ['get', 'k'], 'cpa'], paint: { 'line-color': P.accent, 'line-width': 1.3, 'line-dasharray': [3, 3] } },
    { id: 'cpab', type: 'line', source: 'tgtl', filter: ['==', ['get', 'k'], 'cpab'], layout: { 'line-cap': 'round' }, paint: { 'line-color': P.accent, 'line-width': 3 } },
    { id: 'vec', type: 'line', source: 'tgtl', filter: ['==', ['get', 'k'], 'vec'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-width': ['case', ['==', ['get', 'dg'], 1], 2.4, 1.6] } },
    { id: 'dg-ring', type: 'circle', source: 'tgt', filter: ['==', ['get', 'dg'], 1], paint: { 'circle-radius': 22, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': P.danger, 'circle-stroke-width': 2.5 } },
    { id: 'tgt', type: 'symbol', source: 'tgt', layout: { 'icon-image': ['get', 'img'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': iz(1), 'symbol-sort-key': ['get', 'ord'] }, paint: { 'icon-opacity': ['get', 'op'] } },
    { id: 'sel', type: 'symbol', source: 'tgt', filter: ['==', ['get', 'sel'], 1], layout: { 'icon-image': 'sel', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 8, .8, 15, 1.1] } },
    { id: 'tgt-lbl', type: 'symbol', source: 'tgt', minzoom: 11.5, filter: ['!=', ['get', 'name'], ''], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 10.5, 16, 12.5], 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 1.25, 'text-padding': 3, 'symbol-sort-key': ['get', 'ord'], 'text-letter-spacing': .03 }, paint: { 'text-color': P.ink, 'text-halo-color': P.halo, 'text-halo-width': 1.6, 'text-opacity': ['get', 'op'] } },
    { id: 'own-hdg', type: 'line', source: 'owns', filter: ['==', ['get', 'k'], 'hdg'], paint: { 'line-color': P.ownLine, 'line-width': 1.1, 'line-opacity': .8 } },
    { id: 'own-vec', type: 'line', source: 'owns', filter: ['==', ['get', 'k'], 'vec'], layout: { 'line-cap': 'round' }, paint: { 'line-color': P.ownLine, 'line-width': 3 } },
    { id: 'own-tick', type: 'circle', source: 'owns', filter: ['==', ['get', 'k'], 'tick'], paint: { 'circle-radius': 2.6, 'circle-color': P.ownHalo, 'circle-stroke-color': P.ownLine, 'circle-stroke-width': 1.6 } },
    { id: 'own-raw', type: 'circle', source: 'owns', filter: ['==', ['get', 'k'], 'raw'], paint: { 'circle-radius': 4, 'circle-color': ['get', 'col'], 'circle-stroke-color': P.ownHalo, 'circle-stroke-width': 1.5 } },
    { id: 'ebl', type: 'line', source: 'owns', filter: ['==', ['get', 'k'], 'ebl'], paint: { 'line-color': P.accent, 'line-width': 1.6, 'line-dasharray': [4, 3] } },
    { id: 'mobl', type: 'line', source: 'owns', filter: ['==', ['get', 'k'], 'mobl'], paint: { 'line-color': P.danger, 'line-width': 2.2, 'line-dasharray': [2, 2] } },
    { id: 'mob', type: 'symbol', source: 'owns', filter: ['==', ['get', 'k'], 'mob'], layout: { 'icon-image': 'mob', 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    { id: 'own', type: 'symbol', source: 'owns', filter: ['==', ['get', 'k'], 'own'], layout: { 'icon-image': ['get', 'img'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, .7, 14, 1, 18, 1.3] }, paint: { 'icon-opacity': ['get', 'op'] } },
    { id: 'meas-l', type: 'line', source: 'meas', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round' }, paint: { 'line-color': P.meas, 'line-width': 2.6, 'line-dasharray': [2, 1.5] } },
    { id: 'meas-p', type: 'circle', source: 'meas', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': P.ownHalo, 'circle-stroke-color': P.meas, 'circle-stroke-width': 2.5 } },
    { id: 'meas-t', type: 'symbol', source: 'meas', filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 't']], layout: { 'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-anchor': 'left', 'text-offset': [.9, 0], 'text-allow-overlap': true }, paint: { 'text-color': P.meas, 'text-halo-color': P.halo, 'text-halo-width': 1.6 } },
  ];
  for (const l of L) map.addLayer(l);
}

/* ---------- Farbtafel anwenden ---------- */
const BASE_PAINT = {
  bg: { 'background-color': 'land' }, landuse: { 'fill-color': 'built' }, green: { 'fill-color': 'green' },
  water: { 'fill-color': 'water' }, waterway: { 'line-color': 'water' }, coast: { 'line-color': 'coast' }, pier: { 'line-color': 'coast' },
  bldg: { 'fill-color': 'bldg' }, roadc: { 'line-color': 'roadc' }, road: { 'line-color': 'road' }, rail: { 'line-color': 'rail' },
  wname: { 'text-color': 'wlabel', 'text-halo-color': 'halo' }, place: { 'text-color': 'label', 'text-halo-color': 'halo' },
  'own-acc': { 'fill-color': 'own', 'fill-outline-color': 'own' }, 'own-trk': { 'line-color': 'trk' }, 'own-ring': { 'line-color': 'ring' },
  'own-rlbl': { 'text-color': 'ring', 'text-halo-color': 'halo' }, 'sel-trk': { 'line-color': 'selTrk' }, 'dg-ring': { 'circle-stroke-color': 'danger' },
  'tgt-lbl': { 'text-color': 'ink', 'text-halo-color': 'halo' }, 'own-hdg': { 'line-color': 'ownLine' }, 'own-vec': { 'line-color': 'ownLine' },
  'own-tick': { 'circle-color': 'ownHalo', 'circle-stroke-color': 'ownLine' }, 'own-raw': { 'circle-stroke-color': 'ownHalo' },
  cpa: { 'line-color': 'accent' }, cpab: { 'line-color': 'accent' }, ebl: { 'line-color': 'accent' }, mobl: { 'line-color': 'danger' },
  'snd-lbl': { 'text-halo-color': 'halo' },
  'meas-l': { 'line-color': 'meas' }, 'meas-p': { 'circle-color': 'ownHalo', 'circle-stroke-color': 'meas' }, 'meas-t': { 'text-color': 'meas', 'text-halo-color': 'halo' },
};
function applyPalette() {
  if (!map.isStyleLoaded() && !overlayReady) return;
  const P = PAL[theme];
  for (const [id, props] of Object.entries(BASE_PAINT)) for (const [prop, key] of Object.entries(props)) if (map.getLayer(id)) map.setPaintProperty(id, prop, P[key]);
  map.setPaintProperty('wet', 'fill-color', ['match', ['get', 'subclass'], ['tidalflat', 'saltmarsh'], P.tidal, P.wet]);
  map.setPaintProperty('sea', 'raster-brightness-max', P.seaB); map.setPaintProperty('sea', 'raster-saturation', P.seaS);
  map.setPaintProperty('sat', 'raster-brightness-max', P.satB); map.setPaintProperty('depth', 'raster-brightness-max', P.satB);
  map.setPaintProperty('snd-dot', 'circle-color', ['match', ['get', 'c'], 'shoal', P.sndShoal, 'warn', P.sndWarn, P.sndSafe]);
  map.setPaintProperty('snd-lbl', 'text-color', ['match', ['get', 'c'], 'shoal', P.sndShoal, 'warn', P.sndWarn, P.sndText]);
  map.setPaintProperty('hull-o', 'line-color', ['case', ['==', ['get', 'dg'], 1], P.danger, P.tgtStroke]);
  syncIcons(); drawEdge();
}
function applyLayers() {
  if (!overlayReady) return;
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  vis('sat', S.sat); vis('depth', S.depth && !S.sat); vis('sea', S.seamarks);
  for (const id of ['landuse', 'green', 'wet', 'bldg', 'roadc', 'road', 'rail', 'pier']) vis(id, !S.sat);
  vis('own-ring', S.rings); vis('own-rlbl', S.rings); vis('own-trk', S.track); vis('tgt-lbl', S.labels);
}

/* ================= Zustand ================= */
const ships = new Map();
const statics = load('sk_static', {});
let gps = null, gpsHist = [], gpsErr = '', own = null, lastOwn = load('sk_lastown', null), follow = true, selected = null;
let aisState = { state: 'off', detail: '' }, lastMsg = 0, overlayReady = false;
let measuring = false, measurePts = [], ownTrack = [], dangers = [], nearest = null, probePt = null;

/* ================= GPS + Fusion ================= */
function startGps() {
  if (!('geolocation' in navigator)) { gpsErr = 'Gerät ohne Standortdienst'; return; }
  navigator.geolocation.watchPosition((p) => {
    const c = p.coords, now = Date.now();
    if (c.accuracy > 500) { gpsErr = 'nur grobe WLAN-Ortung'; return; }
    gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy || 30, t: now,
      sog: c.speed != null && c.speed >= 0 ? c.speed / KN : null, cog: c.heading != null && !isNaN(c.heading) && c.speed > 0.3 ? c.heading : null };
    gpsHist.push({ lat: gps.lat, lon: gps.lon, t: now }); if (gpsHist.length > 60) gpsHist.shift();
    gpsErr = '';
  }, (e) => { gpsErr = e.code === 1 ? 'Standort nicht erlaubt' : 'kein GPS-Empfang'; }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}
function gpsMotion() {
  const now = Date.now(), h = gpsHist.filter((p) => now - p.t < 30000);
  if (h.length < 2) return {};
  const a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000;
  if (dt < 5) return {};
  const d = distM(a, b), sog = d / dt / KN;
  return { sog: sog < 0.3 ? 0 : sog, cog: d > 10 ? brg(a, b) : null };
}
function fuse() {
  const now = Date.now(), cands = [];
  if (S.source !== 'ais' && gps && now - gps.t < 300000) {
    const m = gpsMotion(), sog = gps.sog ?? m.sog ?? null, moving = (sog ?? 0) > 1;
    cands.push({ k: 'GPS', lat: gps.lat, lon: gps.lon, sig: Math.max(gps.acc, 3) + (now - gps.t) / 1000 * (moving ? 5 : 0.3), sog, cog: gps.cog ?? m.cog ?? null, hdg: null, age: now - gps.t });
  }
  const oa = S.mmsi ? ships.get(+S.mmsi) : null;
  if (S.source !== 'gps' && oa && oa.la != null) {
    const age = (now - oa.ts) / 1000;
    if (age < 600) {
      const p = oa.s > 0.3 && oa.c != null ? move({ lat: oa.la, lon: oa.lo }, oa.c, oa.s * KN * Math.min(age, 120)) : { lat: oa.la, lon: oa.lo };
      cands.push({ k: 'AIS', ...p, sig: 10 + (oa.s > 0.5 ? 1.2 : 0.05) * age, sog: oa.s ?? null, cog: oa.c ?? null, hdg: oa.h ?? null, age: age * 1000 });
    }
  }
  if (S.demo && !cands.length && demoOwn) cands.push({ k: 'DEMO', ...demoOwn, sig: 6, hdg: demoOwn.cog, age: 0 });
  if (!cands.length) { own = null; return; }
  let p;
  if (cands.length === 2 && distM(cands[0], cands[1]) > 500 + 3 * (cands[0].sig + cands[1].sig)) {
    const a = cands.find((c) => c.k === 'AIS'), g = cands.find((c) => c.k === 'GPS');
    p = a.age < 60000 ? { ...a, src: 'AIS', note: 'GPS weicht stark ab' } : { ...g, src: 'GPS', note: 'AIS veraltet' }; // nur frisches AIS gewinnt
  } else if (cands.length === 1) p = { ...cands[0], src: cands[0].k };
  else {
    const ref = cands[0]; let sx = 0, sy = 0, sw = 0;
    for (const c of cands) { const w = 1 / (c.sig * c.sig), v = xy(c, ref); sx += v[0] * w; sy += v[1] * w; sw += w; }
    const g = cands.find((c) => c.k === 'GPS'), a = cands.find((c) => c.k === 'AIS'), aF = a.age < 60000;
    p = { ...unxy([sx / sw, sy / sw], ref), sig: Math.sqrt(1 / sw), src: 'GPS+AIS', sog: aF ? a.sog : g.sog ?? a.sog, cog: aF ? a.cog : g.cog ?? a.cog, hdg: a.hdg,
      diff: distM(g, a), wG: Math.round(100 * (1 / g.sig ** 2) / sw), gps: g, ais: a };
  }
  p.t = now; own = p; lastOwn = { lat: p.lat, lon: p.lon };
}
setInterval(() => { if (lastOwn) store('sk_lastown', lastOwn); }, 30000);

/* ================= AIS-Ziele ================= */
function upsert(o, rx = Date.now()) {
  const m = +o.m; if (!m) return;
  let t = ships.get(m);
  if (!t) { t = { m, ...(statics[m] || {}), trk: [] }; ships.set(m, t); }
  if (o.k === 'p') {
    // Zeit = Empfangszeit minus Alter laut Server → unabhängig davon, ob die Tablet-Uhr stimmt
    const ts = o.ag != null ? rx - Math.max(0, o.ag) : o.age != null ? rx - o.age * 1000 : rx;
    if (t.la != null && o.ts && t.srvTs && o.ts <= t.srvTs) return;   // gleiche oder ältere Meldung (Server-Uhr gegen Server-Uhr)
    if (t.la != null && !o.ts && ts < t.ts) return;
    Object.assign(t, { la: o.la, lo: o.lo, s: o.s, c: o.c, h: o.h, ts, b: o.b, srvTs: o.ts || t.srvTs, cached: false });
    if (o.st != null) t.st = o.st; if (o.r != null) t.r = o.r;
    if (o.n && !t.n) t.n = o.n;
    if (o.ty) t.ty = o.ty; if (o.A != null && o.A + o.B > 0) Object.assign(t, { A: o.A, B: o.B, C: o.C, D: o.D });
    const lp = t.trk[t.trk.length - 1];
    if (!lp || ts - lp.t > 20000) { t.trk.push({ lat: o.la, lon: o.lo, t: ts }); if (t.trk.length > 120) t.trk.shift(); }
  }
  if (o.k === 's' || o.k === 'snap') {
    for (const k of ['n', 'cs', 'imo', 'ty', 'dst', 'dr', 'eta']) if (o[k] != null && o[k] !== '' && o[k] !== 0) t[k] = o[k];
    if (o.A != null && o.A + o.B > 0) Object.assign(t, { A: o.A, B: o.B, C: o.C, D: o.D });
    statics[m] = { n: t.n, cs: t.cs, imo: t.imo, ty: t.ty, dst: t.dst, dr: t.dr, A: t.A, B: t.B, C: t.C, D: t.D, u: Date.now() };
    staticsDirty = true;
  }
}
let staticsDirty = false;
setInterval(() => {
  if (!staticsDirty) return; staticsDirty = false;
  const keys = Object.keys(statics); if (keys.length > 4000) keys.sort((a, b) => (statics[a].u || 0) - (statics[b].u || 0)).slice(0, keys.length - 4000).forEach((k) => delete statics[k]);
  store('sk_static', statics);
}, 30000);
function shipPos(t, now) { // Koppelort: aisstream liefert je Schiff nur etwa alle 30–60 s eine Position
  const age = Math.min((now - t.ts) / 1000, STALE_MS / 1000);
  return t.s > 0.5 && t.c != null && age > 0 ? move({ lat: t.la, lon: t.lo }, t.c, t.s * KN * age) : { lat: t.la, lon: t.lo };
}
function hullRing(t, p) {
  const dir = t.h ?? t.c; if (dir == null || !(t.A + t.B > 0) || !(t.C + t.D > 0)) return null;
  const L_ = t.A + t.B, half = (t.C + t.D) / 2, off = (t.D - t.C) / 2, bow = Math.min(L_ * 0.18, 14);
  const pts = [[off, t.A], [off + half, t.A - bow], [off + half, -t.B], [off - half, -t.B], [off - half, t.A - bow], [off, t.A]];
  const r = rad(dir);
  return pts.map(([x, y]) => ll(unxy([x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)], p)));
}
function visible(t) {
  if (!S.showB && t.b) return false;
  if (!S.showMoored && !(t.s >= 0.5) && t.m !== selected) return false;
  return true;
}

/* ================= Zeichnen ================= */
function render() {
  if (!overlayReady || !iconsReady) return;
  const now = Date.now(), z = map.getZoom(), ownM = +S.mmsi, C = CATCOL[theme], P = PAL[theme];
  const pts = [], lines = [], nd = [];
  nearest = null;
  for (const [m, t] of ships) {
    if (t.la == null) continue;
    if (now - t.ts > DROP_MS && (S.demo || (linkOk() && now - linkSince > 20000))) { ships.delete(m); continue; } // bei Abbruch: halten
    if (m === ownM && own) continue;
    const p = shipPos(t, now), stale = now - t.ts > STALE_MS; t.p = p;
    if (own) { const c = cpa(own, { lat: p.lat, lon: p.lon, s: t.s, c: t.c }); t.cpa = c.cpa; t.tcpa = c.tcpa; t.dist = distM(own, p); t.brg = brg(own, p); }
    else t.cpa = t.tcpa = t.dist = t.brg = null;
    t.sart = isSart(t) && !stale && (t.dist == null || t.dist < 12 * NM); // Notfall-Sender: Alarm im Umkreis von 12 sm
    const dg = t.sart || (S.alarm && own && !stale && t.tcpa > 0 && t.tcpa < S.tcpaMin * 60 && t.cpa < S.cpaNm * NM && (t.s > 0.5 || own.sog > 0.5)) ? 1 : 0;
    t.dg = dg; if (dg) nd.push(t);
    if (!visible(t) && !dg) continue;
    if (own && t.dist != null && (!nearest || t.dist < nearest.dist)) nearest = t;
    const k = cat(t.ty), moving = t.s >= 0.5;
    const shape = moving ? 'mv' : t.h != null ? 'st' : 'ci';
    pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(p) }, properties: {
      m, img: `${shape}-${k}-${dg}`, rot: t.h ?? t.c ?? 0, sz: t.b ? .8 : 1, op: stale ? .38 : 1, sel: selected === m ? 1 : 0, dg,
      name: t.n || '', ord: dg ? 0 : selected === m ? 1 : t.b ? 3 : 2 } });
    if (moving && t.c != null && !stale) {
      const e = move(p, t.c, t.s * KN * S.vecMin * 60);
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(p), ll(e)] }, properties: { k: 'vec', col: dg ? P.danger : P.vec, dg } });
    }
    if (z >= 14.5) { const h = hullRing(t, p); if (h) lines.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [h] }, properties: { k: 'hull', col: C[k], dg, m } }); }
    if (selected === m && t.trk.length > 1) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.trk.map(ll).concat([ll(p)]) }, properties: { k: 'trk' } });
    // CPA-Grafik: wo stehen beide Schiffe im Moment der engsten Annäherung?
    if (selected === m && own && t.tcpa > 0 && t.tcpa < 3600 && own.cog != null) {
      const oC = move(own, own.cog, (own.sog || 0) * KN * t.tcpa), tC = t.c != null ? move(p, t.c, (t.s || 0) * KN * t.tcpa) : p;
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(own), ll(oC)] }, properties: { k: 'cpa' } });
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(p), ll(tC)] }, properties: { k: 'cpa' } });
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(oC), ll(tC)] }, properties: { k: 'cpab' } });
    }
  }
  dangers = nd.sort((a, b) => (b.sart - a.sart) || a.tcpa - b.tcpa);
  map.getSource('tgt').setData(FC(pts));
  map.getSource('tgtl').setData(FC(lines));
  renderOwn(now);
}
function renderOwn(now) {
  const f = [], P = own, z = map.getZoom();
  const last = ownTrack[ownTrack.length - 1];
  if (P && (!last || (now - last.t > 5000 && distM(last, P) > 8))) {
    ownTrack.push({ lat: P.lat, lon: P.lon, t: now });
    while (ownTrack.length && now - ownTrack[0].t > 3 * 3600e3) ownTrack.shift();
  }
  if (ownTrack.length > 1) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ownTrack.map(ll) }, properties: { k: 'trk' } });
  const c = P || lastOwn;
  if (c && S.rings) {
    const u = S.units === 'inland' ? 1000 : NM, un = S.units === 'inland' ? 'km' : 'sm';
    for (const r of ringSet(u)) {
      f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: circle(c, r * u) }, properties: { k: 'ring' } });
      f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(move(c, map.getBearing() + 45, r * u)) }, properties: { k: 'rlbl', t: `${String(r).replace('.', ',')} ${un}` } });
    }
  }
  if (P) {
    if (P.sig > 4) f.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circle(P, P.sig, 48)] }, properties: { k: 'acc' } });
    if (P.hdg != null) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(P), ll(move(P, P.hdg, mpp(P.lat, z) * 2200))] }, properties: { k: 'hdg' } });
    if (P.sog > 0.3 && P.cog != null) {
      const len = P.sog * KN * S.vecMin * 60;
      f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(P), ll(move(P, P.cog, len))] }, properties: { k: 'vec' } });
      const step = P.sog * KN * 60; if (step / mpp(P.lat, z) > 7) for (let i = 1; i <= S.vecMin; i++) f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(move(P, P.cog, step * i)) }, properties: { k: 'tick' } });
    }
    if (P.src === 'GPS+AIS' && P.diff > 3) {
      f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(P.gps) }, properties: { k: 'raw', col: '#2a6fd0' } });
      f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(P.ais) }, properties: { k: 'raw', col: '#3c9a52' } });
    }
    const dir = P.hdg ?? (P.sog > 0.5 ? P.cog : null);
    f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(P) }, properties: { k: 'own', img: dir == null ? 'ownc' : 'own', rot: dir ?? 0, op: 1 } });
  } else if (lastOwn) {
    f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(lastOwn) }, properties: { k: 'own', img: 'ownc', rot: 0, op: .35 } });
  }
  // Peillinie zum angetippten Punkt
  if (probePt && c) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(c), ll(probePt)] }, properties: { k: 'ebl' } });
  // Mann über Bord
  if (S.mob) {
    f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(S.mob) }, properties: { k: 'mob' } });
    if (c) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [ll(c), ll(S.mob)] }, properties: { k: 'mobl' } });
  }
  map.getSource('owns').setData(FC(f));
}
const mpp = (lat, z) => 40075016.686 * Math.cos(rad(lat)) / (512 * 2 ** z);
function ringSet(u = NM) {
  const c = map.getCenter(), sz = Math.min(map.getContainer().clientWidth, map.getContainer().clientHeight);
  const lim = 0.42 * sz * mpp(c.lat, map.getZoom()) / u;
  const sets = [[.05, .1, .2], [.1, .25, .5], [.25, .5, 1], [.5, 1, 2], [1, 2, 4], [2, 4, 8], [3, 6, 12], [5, 10, 20], [10, 20, 40]];
  let best = sets[0]; for (const s of sets) if (s[2] <= lim) best = s;
  return best;
}

/* ---------- Kantenmaßstab (Breiten-/Längenminuten wie auf der Papierkarte) ---------- */
const edge = $('#edge'), eg = edge.getContext('2d');
let edgeQueued = false;
function drawEdge() { if (!edgeQueued) { edgeQueued = true; requestAnimationFrame(() => { edgeQueued = false; paintEdge(); }); } }
function paintEdge() {
  const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  if (edge.width !== Math.round(W * dpr) || edge.height !== Math.round(H * dpr)) { edge.width = Math.round(W * dpr); edge.height = Math.round(H * dpr); }
  eg.setTransform(dpr, 0, 0, dpr, 0, 0); eg.clearRect(0, 0, W, H);
  if (Math.abs(map.getBearing()) > 0.3) return;
  const P = PAL[theme], top = $('#strip').getBoundingClientRect().bottom, bw = 9, steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
  eg.font = '600 10.5px Archivo, system-ui, sans-serif'; eg.lineWidth = 1;
  // Breite (links)
  const latT = map.unproject([bw, top]).lat, latB = map.unproject([bw, H]).lat, pxPerMin = (H - top) / ((latT - latB) * 60);
  let s = steps.find((x) => x * pxPerMin >= 7) || 300; const major = steps.find((x) => x >= s * 4.5 && x * pxPerMin >= 70) || s * 10;
  const lon0 = map.getCenter().lng;
  eg.fillStyle = P.scalePaper; eg.fillRect(0, top, bw, H - top);
  for (let k = Math.floor(latB * 60 / s); k <= Math.ceil(latT * 60 / s); k++) {
    if (k % 2) continue;
    const y1 = map.project([lon0, k * s / 60]).y, y2 = map.project([lon0, (k + 1) * s / 60]).y;
    eg.fillStyle = P.scaleInk; eg.fillRect(0, Math.max(top, y2), bw, Math.min(H, y1) - Math.max(top, y2));
  }
  eg.strokeStyle = P.scaleInk; eg.strokeRect(.5, top + .5, bw, H - top);
  eg.save(); eg.fillStyle = P.scaleInk; eg.textBaseline = 'middle';
  for (let k = Math.ceil(latB * 60 / major); k <= Math.floor(latT * 60 / major); k++) {
    const lat = k * major / 60, y = map.project([lon0, lat]).y; if (y < top + 30 || y > H - 40) continue;
    eg.fillRect(bw, y - .5, 6, 1);
    eg.save(); eg.translate(bw + 9, y); eg.rotate(-Math.PI / 2); eg.textAlign = 'center';
    halo(dm(lat, true, major < 1 ? 1 : 0).replace(/,0′|′/, '′'), 0, 6, P);
    eg.restore();
  }
  eg.restore();
  // Länge (unten)
  const lonL = map.unproject([0, H - bw]).lng, lonR = map.unproject([W, H - bw]).lng, pxPerMinX = W / ((lonR - lonL) * 60);
  s = steps.find((x) => x * pxPerMinX >= 7) || 300; const majorX = steps.find((x) => x >= s * 4.5 && x * pxPerMinX >= 90) || s * 10;
  const lat0 = map.getCenter().lat;
  eg.fillStyle = P.scalePaper; eg.fillRect(bw, H - bw, W - bw, bw);
  for (let k = Math.floor(lonL * 60 / s); k <= Math.ceil(lonR * 60 / s); k++) {
    if (k % 2) continue;
    const x1 = map.project([k * s / 60, lat0]).x, x2 = map.project([(k + 1) * s / 60, lat0]).x;
    eg.fillStyle = P.scaleInk; eg.fillRect(Math.max(bw, x1), H - bw, Math.min(W, x2) - Math.max(bw, x1), bw);
  }
  eg.strokeStyle = P.scaleInk; eg.strokeRect(bw + .5, H - bw + .5, W - bw, bw);
  eg.fillStyle = P.scaleInk; eg.textAlign = 'center'; eg.textBaseline = 'bottom';
  for (let k = Math.ceil(lonL * 60 / majorX); k <= Math.floor(lonR * 60 / majorX); k++) {
    const lon = k * majorX / 60, x = map.project([lon, lat0]).x; if (x < 60 || x > W - 140) continue;
    eg.fillRect(x - .5, H - bw - 6, 1, 6);
    halo(dm(lon, false, majorX < 1 ? 1 : 0).replace(/,0′|′/, '′'), x, H - bw - 8, P);
  }
}
function halo(t, x, y, P) { eg.lineWidth = 3; eg.strokeStyle = P.scalePaper; eg.lineJoin = 'round'; eg.strokeText(t, x, y); eg.fillStyle = P.scaleInk; eg.fillText(t, x, y); }

/* ================= AIS-Verbindung =================
   Relay im Cache-Modus: Schnappschuss beim Verbinden, danach Änderungen alle 3 s, Herzschlag alle 10 s.
   Robustheit: Lebenszeichen-Wache (35 s ohne Daten → neu verbinden), sofortiger Wiederaufbau nach Abbruch,
   Schiffe bleiben während einer Unterbrechung stehen (werden gespeichert) und werden nicht gelöscht. */
let ws = null, wsRetry = 0, subBox = null, retryTimer = null, hideTimer = null, pingTimer = null, connectedAt = 0, lastRx = 0, linkSince = 0, lostAt = 0;
let sockStart = 0, relayMode = '', collectorOk = true, rotTimer = null, maxSrvTs = 0, lastBoxSent = null, firstSub = true;
function wantBox() {
  const b = map.getBounds(), c = map.getCenter();
  let s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  const dLat = n - s, dLon = e - w; s -= dLat * .3; n += dLat * .3; w -= dLon * .3; e += dLon * .3;
  const p = own || lastOwn;
  if (p) { s = Math.min(s, p.lat - 0.25); n = Math.max(n, p.lat + 0.25); w = Math.min(w, p.lon - 0.4); e = Math.max(e, p.lon + 0.4); }
  // Mindestgröße ~ 70 × 70 sm, damit beim Öffnen sofort etwas im Umfeld zu sehen ist
  if (n - s < 1.2) { const m = (n + s) / 2; s = m - .6; n = m + .6; }
  if (e - w < 2) { const m = (e + w) / 2; w = m - 1; e = m + 1; }
  const k = p ? { lat: p.lat, lng: p.lon } : c; // Kappung um das eigene Schiff, damit sein Umfeld nie herausfällt
  if (n - s > 3) { s = k.lat - 1.5; n = k.lat + 1.5; }
  if (e - w > 5) { w = k.lng - 2.5; e = k.lng + 2.5; }
  const r = (x) => Math.round(x * 1000) / 1000;
  return [[r(Math.max(-89, s)), r(w)], [r(Math.min(89, n)), r(e)]];
}
const contains = (a, b) => a && b[0][0] >= a[0][0] && b[0][1] >= a[0][1] && b[1][0] <= a[1][0] && b[1][1] <= a[1][1];
const area = (b) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]);
function maybeSub(force) {
  if (!ws || ws.readyState !== 1) return;
  const want = wantBox();
  if (!force && contains(subBox, want) && area(subBox) < area(want) * 4) return;
  const pl = (want[1][0] - want[0][0]) * .25, po = (want[1][1] - want[0][1]) * .25, r3 = (x) => Math.round(x * 1000) / 1000;
  const sent = [[r3(want[0][0] - pl), r3(want[0][1] - po)], [r3(want[1][0] + pl), r3(want[1][1] + po)]];
  // nach Wiederverbindung im selben Gebiet nur die Änderungen holen (spart Daten an Bord)
  const since = firstSub && maxSrvTs && contains(lastBoxSent, want) ? maxSrvTs - 5000 : 0;
  subBox = sent; lastBoxSent = sent; firstSub = false;
  const msg = { bbox: sent, v: VERSION }; if (since) msg.since = since; if (S.key) msg.key = S.key;
  ws.send(JSON.stringify(msg));
}
const linkOk = () => !!ws && ws.readyState <= 1 && Date.now() - lastRx < 25000 && aisState.state === 'live';
function connect() {
  if (S.demo || ws || document.hidden) return;
  clearTimeout(retryTimer);
  if (aisState.state !== 'live') setAis('connecting');
  let sock, opened = false;
  try { sock = ws = new WebSocket(RELAY_URL); } catch (_) { ws = null; retry(); return; }
  sockStart = Date.now();
  sock.onopen = () => {
    opened = true; connectedAt = lastRx = Date.now(); subBox = null; firstSub = true; maybeSub(true);
    clearTimeout(rotTimer); rotTimer = setTimeout(rotate, 130000); // Server trennt nach ~150 s → vorher nahtlos wechseln
    clearInterval(pingTimer); pingTimer = setInterval(() => { if (ws === sock && sock.readyState === 1) sock.send('{"ping":1}'); }, 20000);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    const rx = lastRx = Date.now();
    let o; try { o = JSON.parse(ev.data); } catch (_) { return; }
    if (o.k === 'status') { if (o.mode) relayMode = o.mode; setAis(o.state, o.detail); return; }
    if (o.k === 'hb') { relayMode = o.mode || relayMode; collectorOk = o.col !== false; return; }
    if (o.k === 'pong') return;
    if (o.k === 'snap') { for (const v of o.v || []) { upsert({ ...v, k: 'p' }, rx); upsert({ ...v, k: 'snap' }, rx); } if (o.now) maxSrvTs = o.now; lastMsg = rx; markLive(); return; }
    if (o.k === 'p' || o.k === 's') { upsert(o, rx); lastMsg = rx; markLive(); }
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null; clearInterval(pingTimer); clearTimeout(rotTimer);
    if (!lostAt) lostAt = Date.now();
    if (ev.code === 4001) setAis('rejected', aisState.detail);
    else if (!['nokey', 'rejected'].includes(aisState.state)) setAis(navigator.onLine === false ? 'offline' : 'reconnect');
    if (opened && Date.now() - connectedAt > 60000) wsRetry = 0; // lief stabil (z. B. Server-Zeitlimit) → sofort neu
    retry();
  };
  sock.onerror = () => {};
}
function rotate() { // neue Verbindung aufbauen, alte erst schließen, wenn die neue Daten liefert
  if (!ws || ws.readyState !== 1 || document.hidden || relayMode !== 'cache') return; // Direktmodus: kein 2. aisstream-Platz
  const old = ws; old.onclose = null; ws = null; clearInterval(pingTimer);
  connect();
  const nw = ws, kill = () => { try { old.close(); } catch (_) {} };
  if (!nw) { kill(); return; }
  nw.addEventListener('message', () => setTimeout(kill, 500), { once: true }); setTimeout(kill, 12000);
}
function markLive() { if (aisState.state !== 'live') setAis('live'); }
function retry() {
  if (S.demo || document.hidden) return;
  clearTimeout(retryTimer);
  const base = aisState.state === 'nokey' ? 120000 : aisState.state === 'rejected' ? 45000 : wsRetry;
  retryTimer = setTimeout(connect, base * (0.8 + Math.random() * 0.4) + 250);
  wsRetry = Math.min(Math.max(1000, wsRetry * 1.8), 15000);
}
function disconnect() { clearTimeout(retryTimer); clearInterval(pingTimer); clearTimeout(rotTimer); if (ws) { const w = ws; ws = null; w.onclose = null; try { w.close(); } catch (_) {} } }
function forceReconnect() { disconnect(); if (!lostAt) lostAt = Date.now(); setAis('reconnect'); wsRetry = 0; connect(); }
function setAis(state, detail = '') {
  if (aisState.state === 'live' && (state === 'relay' || state === 'connecting') && Date.now() - lastRx < 25000) return;
  if (state === 'outside') { aisState = { state, detail }; return; }
  if (state === 'live') { wsRetry = 0; lostAt = 0; if (!linkSince) linkSince = Date.now(); }
  else if (state !== 'connecting') linkSince = 0;
  aisState = { state, detail };
}
// Wache: halb offene Verbindungen (Funkloch, WLAN↔LTE, iPad gesperrt) erkennen und neu aufbauen
setInterval(() => {
  if (S.demo || document.hidden || !ws) return;
  if (ws.readyState === 1 && Date.now() - lastRx > 25000) forceReconnect();
  else if (ws.readyState === 0 && Date.now() - sockStart > 15000) forceReconnect(); // Aufbau hängt (Funkloch)
}, 4000);
addEventListener('online', () => { wsRetry = 0; if (ws && Date.now() - lastRx > 10000) forceReconnect(); else connect(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(hideTimer); hideTimer = setTimeout(disconnect, 120000); }
  else { clearTimeout(hideTimer); if (ws && Date.now() - lastRx > 20000) forceReconnect(); else { wsRetry = 0; connect(); } wake(); }
});
// Schiffe lokal sichern → nach Neustart oder Verbindungsabbruch sofort wieder da
function saveShips() {
  const now = Date.now(), arr = [];
  for (const t of ships.values()) if (t.la != null && now - t.ts < 60 * 60e3 && !(t.m >= 211000100 && t.m <= 211000999))
    arr.push([t.m, t.la, t.lo, t.s ?? null, t.c ?? null, t.h ?? null, t.ts, t.b ? 1 : 0, t.st ?? null, t.n || null]);
  store('sk_ships', { t: now, v: arr.slice(-1500) });
}
setInterval(saveShips, 20000);
addEventListener('pagehide', saveShips);
(function restoreShips() {
  const d = load('sk_ships', null); if (!d || !Array.isArray(d.v)) return;
  for (const [m, la, lo, s, c, h, ts, b, st, n] of d.v) if (Date.now() - ts < 60 * 60e3) {
    upsert({ k: 'p', m, la, lo, s, c, h, b, st, n, ag: Date.now() - ts }, Date.now());
    const t = ships.get(m); if (t) t.cached = true;
  }
})();

/* ================= Demo ================= */
let demoOwn = null, demoTimer = null;
function startDemo() {
  const c = own || lastOwn || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  demoOwn = gps ? null : { lat: c.lat, lon: c.lon, sog: 7, cog: 75 };
  const names = ['NORDLICHT', 'ELBE TRADER', 'KIELER BUCHT', 'ANNA MARIA', 'STENA GERMANICA', 'HOLSTENTOR', 'BRUNSBÜTTEL', 'SEEADLER', 'MARE NOSTRUM', 'FEHMARN', 'POLARIS', 'NIXE', 'LOTSE 3', 'SVEA', 'GORCH FOCK', 'OSTSEE', 'WIKING'];
  const tys = [70, 80, 60, 37, 69, 71, 52, 36, 79, 30, 84, 37, 50, 61, 36, 74, 0];
  const base = demoOwn || c, now = Date.now();
  names.forEach((n, i) => {
    const p = move(base, (i * 47) % 360, (0.4 + (i % 6) * 0.45) * NM), s = [0, 3, 6, 9, 11, 14][i % 6] + (i % 3);
    upsert({ k: 'p', m: 211000100 + i, la: p.lat, lo: p.lon, s, c: (i * 83) % 360, h: (i * 83) % 360, b: tys[i] === 37 || tys[i] === 36 ? 1 : 0, n, st: s ? 0 : 5 }, now);
    upsert({ k: 's', m: 211000100 + i, n, ty: tys[i], cs: `DA${1000 + i}`, dst: ['KIEL', 'HAMBURG', 'BRUNSBUETTEL', 'ROSTOCK'][i % 4], A: 60 + i * 5, B: 20 + i, C: 7 + (i % 4), D: 7 + (i % 4), dr: 4 + (i % 5) }, now);
  });
  const cp = move(base, 75, 1.2 * NM), cp2 = move(cp, 340, 1.0 * NM);
  upsert({ k: 'p', m: 211000999, la: cp2.lat, lo: cp2.lon, s: 9, c: 160, h: 160, n: 'KOLLISIONSKURS', st: 0 }, now);
  upsert({ k: 's', m: 211000999, n: 'KOLLISIONSKURS', ty: 70, A: 120, B: 30, C: 10, D: 10, dst: 'HAMBURG' }, now);
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    const t0 = Date.now();
    if (demoOwn) { const q = move(demoOwn, demoOwn.cog, demoOwn.sog * KN); demoOwn.lat = q.lat; demoOwn.lon = q.lon; }
    for (const t of ships.values()) if (t.m >= 211000100 && t.m <= 211000999 && t0 - t.ts > 2500) {
      const q = move({ lat: t.la, lon: t.lo }, t.c ?? 0, (t.s || 0) * KN * (t0 - t.ts) / 1000);
      if (t.m % 5 === 0 && t.c != null) { t.c = (t.c + 0.6) % 360; t.h = t.c; }
      upsert({ k: 'p', m: t.m, la: q.lat, lo: q.lon, s: t.s, c: t.c, h: t.h, b: t.b }, t0);
    }
  }, 1000);
  setAis('demo');
}
function stopDemo() { clearInterval(demoTimer); demoOwn = null; for (const m of [...ships.keys()]) if (m >= 211000100 && m <= 211000999) ships.delete(m); }

/* ================= Oberfläche: Leiste, Alarm, HUD ================= */
function triSvg(col, dg) { return `<svg viewBox="-14 -14 28 28"><path d="M0-11 6.4 8.6-6.4 8.6Z" fill="${col}" stroke="${dg ? 'var(--danger)' : '#1b1f22'}" stroke-width="${dg ? 2.4 : 1.2}" stroke-linejoin="round"/></svg>`; }
function renderStrip() {
  const p = own;
  $('#vSog').textContent = p ? spd(p.sog) : '–'; $('#vSogU').textContent = spdU();
  $('#vCog').textContent = p && p.cog != null && p.sog > 0.3 ? p3(p.cog) : '–';
  $('#vHdg').textContent = p && p.hdg != null ? p3(p.hdg) : '–';
  const q = p || lastOwn;
  $('#vLat').textContent = q ? dm(q.lat, true) : 'keine Position';
  $('#vLon').textContent = q ? dm(q.lon, false) : '';
  const src = $('#vSrc');
  if (p) { src.textContent = p.src === 'GPS+AIS' ? 'GPS + AIS' : p.src; src.className = 'src'; }
  else { src.textContent = S.source !== 'gps' && !S.mmsi && S.source === 'ais' ? 'MMSI fehlt' : gpsErr || 'sucht'; src.className = 'src warn'; }
  const chip = $('#cAis'), n = [...ships.values()].filter((t) => t.la != null && t.m !== +S.mmsi).length, fresh = Date.now() - lastMsg < 90000;
  const st = aisState.state;
  let cls = 'wait', txt = 'AIS verbindet';
  const held = lostAt ? `vor ${fmtAge(Date.now() - lostAt).replace(/ \d+ min$/, '')}` : '';
  if (st === 'demo') { cls = 'demo'; txt = `Demo · ${n} Schiffe`; }
  else if (st === 'nokey') { cls = 'bad'; txt = 'AIS-Schlüssel ungültig'; }
  else if (st === 'rejected') { cls = 'bad'; txt = `AIS belegt · ${n} gehalten`; }
  else if (st === 'offline') { cls = 'bad'; txt = n ? `Kein Internet · ${n} gehalten` : 'Kein Internet'; }
  else if (st === 'outside') { cls = 'wait'; txt = 'AIS: außerhalb des Gebiets'; }
  else if (linkOk() && !collectorOk) { cls = 'wait'; txt = `AIS-Quelle gestört · ${n}`; }
  else if (linkOk()) { cls = 'ok'; txt = `AIS live · ${n}`; }
  else if (n && lostAt) { cls = 'wait'; txt = `AIS unterbrochen · ${n} gehalten`; }
  chip.title = held ? `Verbindung weg seit ${held}. Die Schiffe bleiben auf ihren letzten Positionen und werden blasser.` : '';
  chip.className = `chip ${cls}`; $('#vAis').textContent = txt;
  $('#vTime').textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#vTz').textContent = tz();
  const km = q ? nokKm(q) : null, ki = $('#iKm');
  ki.hidden = km == null; if (km != null) $('#vKm').textContent = de(km, 1);
  renderMob(); renderTideStrip();
  $('#listBadge').hidden = !dangers.length; $('#listBadge').textContent = dangers.length;
}
let audioCtx = null, ackKey = '', lastBeep = 0;
function beep(force) {
  if (!S.sound && !force) return;
  try {
    if (!audioCtx) { if (!force) { navigator.vibrate?.([300, 150, 300]); return; } unlockAudio(); }
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    navigator.vibrate?.([300, 150, 300]);
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; o.type = 'square'; g.gain.value = 0.0001;
      g.gain.setValueAtTime(0.16, t0 + i * 0.26); g.gain.setValueAtTime(0.0001, t0 + i * 0.26 + 0.15);
      o.connect(g).connect(audioCtx.destination); o.start(t0 + i * 0.26); o.stop(t0 + i * 0.26 + 0.18);
    }
  } catch (_) { /* kein Audio */ }
}
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return; }
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  if (!audioCtx.__u) { const b = audioCtx.createBufferSource(); b.buffer = audioCtx.createBuffer(1, 1, 22050); b.connect(audioCtx.destination); b.start(0); audioCtx.__u = true; }
}
for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, () => { unlockAudio(); wake(); }, { passive: true, capture: true });
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS: Seite nicht als Ganzes zoomen
// Alarm: blinkt + piept (alle 20 s) bis „Gesehen"; neues Ziel löst erneut aus; „5 min stumm" schaltet nur den Ton ab
const acked = new Set(); let muteUntil = 0;
function passSide(t) { // An welcher Seite passiert das Ziel im CPA?
  if (!own || !(t.tcpa > 0)) return '';
  const oC = own.cog != null ? move(own, own.cog, (own.sog || 0) * KN * t.tcpa) : own;
  const tC = t.c != null ? move(t.p, t.c, (t.s || 0) * KN * t.tcpa) : t.p;
  if (distM(oC, tC) < 15) return 'auf Kollisionskurs';
  const side = relSide(own, brg(oC, tC));
  return side ? (side.startsWith('Stb') ? 'passiert an Stb' : side.startsWith('Bb') ? 'passiert an Bb' : side.includes('voraus') ? 'kreuzt voraus' : 'kreuzt achteraus') : '';
}
function renderAlert() {
  const el = $('#alert');
  for (const m of [...acked]) if (!dangers.some((d) => d.m === m)) acked.delete(m);
  if (!dangers.length) { el.hidden = true; return; }
  const d = dangers[0], fresh = dangers.filter((x) => !acked.has(x.m)), live = fresh.length > 0;
  const audioOff = S.sound && (!audioCtx || audioCtx.state !== 'running');
  const head = d.sart ? `NOTFALL-SENDER: ${esc(d.n || d.m)}` : `${esc(d.n || d.m)} – ${nmTxt(d.cpa)} Abstand in ${Math.max(1, Math.round(d.tcpa / 60))} min`;
  const sub = d.sart ? `AIS-SART / MOB / EPIRB · ${nmTxt(d.dist)} · Peilung ${p3(d.brg)}°` : `${passSide(d)}${dangers.length > 1 ? ` · und ${dangers.length - 1} weitere` : ''}`;
  el.className = live ? 'live' : 'quiet';
  el.innerHTML = `<svg class="tri" viewBox="0 0 24 24"><path d="M12 2.8 22 20.5H2Z" fill="currentColor" stroke="none"/><path d="M12 9v5.2" stroke="var(--alert-bg)" stroke-width="2.4"/><circle cx="12" cy="17.2" r="1.3" fill="var(--alert-bg)" stroke="none"/></svg>
    <div class="txt" data-show>${head}<small>${sub}${audioOff ? ' · <b>Ton gesperrt – einmal auf den Bildschirm tippen</b>' : Date.now() < muteUntil ? ' · Ton stumm' : ''}</small></div>
    ${live ? '<button type="button" data-ack>Gesehen</button>' : ''}<button type="button" data-mute>${Date.now() < muteUntil ? 'Ton an' : '5 min stumm'}</button>`;
  el.hidden = false;
  if (live && Date.now() >= muteUntil && Date.now() - lastBeep > 20000) { lastBeep = Date.now(); beep(); }
}
$('#alert').onclick = (e) => {
  if (e.target.closest('[data-ack]')) { dangers.forEach((x) => acked.add(x.m)); renderAlert(); return; }
  if (e.target.closest('[data-mute]')) { muteUntil = Date.now() < muteUntil ? 0 : Date.now() + 5 * 60e3; renderAlert(); return; }
  const d = dangers[0]; if (d) { dangers.forEach((x) => acked.add(x.m)); setFollow(false); select(d.m); map.easeTo({ center: ll(d.p), duration: 600 }); }
};
function renderNear() {
  const el = $('#near'), t = dangers[0] || nearest;
  if (!t || !own || measuring || S.mob) { el.hidden = true; return; }
  const dg = !!t.dg, C = CATCOL[theme], ps = passSide(t);
  const sub = t.sart ? `Peilung ${p3(t.brg)}°` : dg ? `CPA ${nmTxt(t.cpa)} in ${Math.max(1, Math.round(t.tcpa / 60))} min` : t.tcpa > 0 && t.tcpa < 3600 && (t.s >= 0.5 || own.sog >= 0.5) ? `${ps || 'CPA'} ${nmTxt(t.cpa)} · ${Math.max(1, Math.round(t.tcpa / 60))} min` : `${p3(t.brg)}° · ${relSide(own, t.brg) || 'entfernt sich'}`;
  el.className = dg ? 'danger' : '';
  el.innerHTML = `<span class="ico">${triSvg(C[cat(t.ty)], dg)}</span><span class="cap">${t.sart ? 'Notfall-Sender' : dg ? 'Annäherung' : 'Nächstes Schiff'}</span>
    <span class="fig">${nmTxt(t.dist)}<small>${sub}</small></span><b>${esc(t.n || t.m)}</b>`;
  el.hidden = false; el.dataset.m = t.m;
}
$('#near').onclick = () => { const t = ships.get(+$('#near').dataset.m); if (t) { setFollow(false); select(t.m); map.easeTo({ center: ll(t.p), duration: 600 }); } };

/* ================= Kanal-km (Nord-Ostsee-Kanal) ================= */
let NOK = null;
fetch('nok_km.json').then((r) => r.json()).then((d) => { NOK = d.pts; }).catch(() => {});
function nokKm(p) { // Lot auf die kalibrierte Kanalachse; nur im Kanal (< 350 m von der Achse)
  if (!NOK || p.lat < 53.85 || p.lat > 54.4 || p.lon < 9.08 || p.lon > 10.18) return null;
  let best = null, bd = 350;
  for (let i = 1; i < NOK.length; i++) {
    const a = { lat: NOK[i - 1][0], lon: NOK[i - 1][1] }, b = { lat: NOK[i][0], lon: NOK[i][1] };
    const ab = xy(b, a), ap = xy(p, a), L2 = ab[0] ** 2 + ab[1] ** 2; if (!L2) continue;
    const u = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / L2)), d = Math.hypot(ap[0] - u * ab[0], ap[1] - u * ab[1]);
    if (d < bd) { bd = d; best = NOK[i - 1][2] + u * (NOK[i][2] - NOK[i - 1][2]); }
  }
  return best != null && best >= 0 && best <= 98.7 ? best : null; // nur zwischen den Schleusen
}

/* ================= Mann über Bord ================= */
$('#tMob').onclick = () => {
  if (S.mob) { ask('MOB-Markierung löschen?', 'Löschen', true).then((y) => { if (y) { S.mob = null; save(); renderMob(); render(); } }); return; }
  const p = own || lastOwn; if (!p) { toast('Keine Position – MOB kann nicht gesetzt werden'); return; }
  S.mob = { lat: p.lat, lon: p.lon, t: Date.now() }; save(); beep(true); setFollow(true); renderMob(); render();
};
function renderMob() {
  const el = $('#mobCard'); $('#tMob').classList.toggle('on', !!S.mob);
  if (!S.mob) { el.hidden = true; return; }
  const o = own || lastOwn, age = Date.now() - S.mob.t, mm = Math.floor(age / 60000), ss = Math.floor(age / 1000) % 60;
  el.innerHTML = `<span class="cap">Mann über Bord · vor ${mm}:${String(ss).padStart(2, '0')} min</span>
    <span class="fig">${o ? nmTxt(distM(o, S.mob)) : '–'}<small>${o ? p3(brg(o, S.mob)) + '° · ' + relSide(own, brg(o, S.mob)) : ''}</small></span>
    <b>${dm(S.mob.lat, true)} ${dm(S.mob.lon, false)}</b>`;
  el.hidden = false;
}
$('#mobCard').onclick = () => { if (S.mob) map.easeTo({ center: ll(S.mob), zoom: Math.max(map.getZoom(), 15), duration: 600 }); };

/* ================= Gezeiten + aktuelle Wassertiefe =================
   Tiefe jetzt = Kartentiefe (EMODnet, bezogen auf LAT ≈ Seekartennull) + Wasserstand über SKN am Pegel.
   Wasserstand: gemessen (PEGELONLINE, inkl. Windstau), sonst amtliche BSH-Vorausberechnung (Kosinus zwischen HW/NW). */
const TIDES_URL = 'https://twybfsbfbxvwwxbdphum.supabase.co/functions/v1/tides';
const EMOD_WCS = 'https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean&format=text/plain';
let GAUGES = [], TIDE = { gauges: [], nok: [], t: 0, at: null }, tideBusy = false;
fetch('gauges.json').then((r) => r.json()).then((g) => { GAUGES = g.map(([id, name, lat, lon]) => ({ id, name, lat, lon })); loadTides(); }).catch(() => {});
function nearGauges(p, n = 3) {
  return GAUGES.map((g) => ({ g, d: distM(p, g) })).filter((x) => x.d < 70000).sort((a, b) => a.d - b.d).slice(0, n).map((x) => x.g);
}
async function loadTides(force) {
  const p = own || lastOwn || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  if (!GAUGES.length || tideBusy) return;
  const vc0 = { lat: map.getCenter().lat, lon: map.getCenter().lng };
  if (!force && TIDE.at && Date.now() - TIDE.t < 110000 && distM(TIDE.at, p) < 8000 && TIDE.vc && distM(TIDE.vc, vc0) < 10000) return;
  const vc = { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const ids = [...new Set([...nearGauges(p, 3), ...nearGauges(vc, 3)].map((g) => g.id))].slice(0, 6);
  const nearNok = p.lat > 53.8 && p.lat < 54.5 && p.lon > 9.0 && p.lon < 10.3;
  if (!ids.length && !nearNok) { TIDE = { gauges: [], nok: [], t: Date.now(), at: p }; return; }
  tideBusy = true;
  try {
    const r = await fetch(`${TIDES_URL}?ids=${ids.join(',')}${nearNok ? '&nok=1' : ''}`);
    const d = await r.json();
    TIDE = { gauges: (d.gauges || []).filter((g) => !g.error), nok: d.nok || [], t: Date.now(), at: p, vc: vc0, srvT: d.t };
    store('sk_tide', TIDE);
    renderSoundings();
    if (drawer === 'tide' && !(document.activeElement && /INPUT/.test(document.activeElement.tagName) && dBody.contains(document.activeElement)) && Date.now() - drawerTouch > 1500) renderTide(true);
  } catch (_) { if (!TIDE.gauges.length) { const c = load('sk_tide', null); if (c) TIDE = { ...c, stale: true }; } }
  finally { tideBusy = false; }
}
setInterval(() => loadTides(), 30000);
function predAt(g, t) { // cm über SKN: amtliche BSH-Tidenkurve (10 min), sonst Näherung zwischen HW und NW
  const c = g.curve;
  if (c && c.h && c.h.length > 1) { const i = (t - c.t0) / c.step, k = Math.floor(i); if (k >= 0 && k + 1 < c.h.length) return c.h[k] + (c.h[k + 1] - c.h[k]) * (i - k); }
  const ev = g.ev || [];
  for (let i = 1; i < ev.length; i++) if (ev[i].t >= t && ev[i - 1].t <= t) {
    const a = ev[i - 1], b = ev[i]; if (a.ty === b.ty) return null;
    return a.h + (b.h - a.h) * (1 - Math.cos(Math.PI * (t - a.t) / (b.t - a.t))) / 2;
  }
  return null;
}
function levelOf(g, t = Date.now()) { // aktueller Stand: Messung (fortgeschrieben mit der Vorhersage-Steigung), sonst Vorhersage
  const pr = predAt(g, t), m = g.now || {};
  if (m.meas != null && m.measT && t - m.measT < 20 * 60e3) {
    const pm = predAt(g, m.measT);
    return { h: m.meas + (pr != null && pm != null ? pr - pm : 0), src: 'gemessen', surge: m.surge };
  }
  if (pr != null) return { h: pr + (m.surge != null && m.measT && t - m.measT < 60 * 60e3 ? m.surge : 0), src: 'vorhergesagt', surge: m.surge };
  return null;
}
function tideAt(p) { // Wasserstand über SKN (m) am Ort: Abstandsgewichtung der zwei nächsten Pegel
  if (nokKm(p) != null) return null; // Kanal: geregelter Wasserstand, keine Tide
  // nur Pegel im Umkreis von 25 km – weiter weg weicht die Tide zu stark ab (dann lieber kein Punkt)
  const list = TIDE.gauges.map((g) => ({ g, d: Math.max(500, distM(p, g)), l: levelOf(g) })).filter((x) => x.l && x.d < 25000).sort((a, b) => a.d - b.d).slice(0, 2);
  if (!list.length) return null;
  let sw = 0, sh = 0; for (const x of list) { const w = 1 / (x.d * x.d); sw += w; sh += w * x.l.h; }
  return { h: sh / sw / 100, src: list[0].l.src, g: list[0].g, d: list[0].d, surge: list[0].l.surge };
}
function trendOf(g) { const a = predAt(g, Date.now()), b = predAt(g, Date.now() + 15 * 60e3); return a == null || b == null ? 0 : b - a; }
function nextEvents(g, n = 4) { const now = Date.now(); return (g.ev || []).filter((e) => e.t > now).slice(0, n); }
const hm = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const mTxt = (cm, sign) => cm == null ? '–' : `${sign && cm > 0 ? '+' : ''}${de(cm / 100, 2)} m`;

/* ---- Tiefenraster (EMODnet, 1/16′ ≈ 115 m), in Kacheln zu 1/16° geladen ---- */
const TILE = 1 / 16, CELL = 1 / 960, depthTiles = new Map(), waterCache = new Map();
function tileKey(i, j) { return `${i}:${j}`; }
function loadDepthTile(i, j) {
  const k = tileKey(i, j), old = depthTiles.get(k);
  if (old && !(old.failed && Date.now() - old.failed > 60000)) return old;
  const s = i * TILE, w = j * TILE, rec = { ok: false, p: null };
  rec.p = fetch(`${EMOD_WCS}&subset=Lat(${(s + CELL / 4).toFixed(5)},${(s + TILE - CELL / 4).toFixed(5)})&subset=Long(${(w + CELL / 4).toFixed(5)},${(w + TILE - CELL / 4).toFixed(5)})`)
    .then((r) => r.ok ? r.text() : Promise.reject(r.status)).then((txt) => {
      const num = (name) => +(txt.match(new RegExp(`"${name}", (-?[\\d.eE-]+)`)) || [])[1];
      const x0 = num('elt_0_2'), dx = num('elt_0_0'), y0 = num('elt_1_2'), dy = num('elt_1_1');
      const vals = txt.split('Band 0:')[1].trim().split(/\s+/).map(Number), cols = Math.round(TILE / dx);
      Object.assign(rec, { ok: true, x0, dx, y0, dy, cols, rows: Math.round(vals.length / cols), v: vals });
      renderSoundings();
    }).catch(() => { rec.failed = Date.now(); });
  depthTiles.set(k, rec);
  if (depthTiles.size > 400) depthTiles.delete(depthTiles.keys().next().value);
  return rec;
}
let sndQueued = false;
function renderSoundings() { if (!sndQueued) { sndQueued = true; requestAnimationFrame(() => { sndQueued = false; paintSoundings(); }); } }
function sndClass(d) {
  if (S.draught > 0) { const need = S.draught + S.ukc; return d < need ? 'shoal' : d < need + 1 ? 'warn' : 'safe'; }
  return d < 2 ? 'shoal' : d < 5 ? 'warn' : 'safe';
}
function paintSoundings() {
  if (!overlayReady) return;
  const src = map.getSource('snd'); if (!src) return;
  const z = map.getZoom();
  if (!S.depthPts || z < 11.5) { src.setData(FC()); return; }
  const b = map.getBounds(), c = map.getCenter(), pxPerCell = 115 / mpp(c.lat, z);
  const stride = Math.max(1, Math.ceil(42 / pxPerCell));
  const i0 = Math.floor(b.getSouth() / TILE), i1 = Math.floor(b.getNorth() / TILE), j0 = Math.floor(b.getWest() / TILE), j1 = Math.floor(b.getEast() / TILE);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 40) { src.setData(FC()); return; }
  const f = [], cvs = map.getCanvas(), W = cvs.clientWidth, H = cvs.clientHeight;
  const tideCache = new Map(), tilesReady = map.areTilesLoaded();
  scan: for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const t = loadDepthTile(i, j); if (!t.ok) continue;
    for (let r = 0; r < t.rows; r++) {
      const gr = i * t.rows + (t.rows - 1 - r); if (gr % stride) continue; // Zeile 0 = Norden
      const lat = t.y0 + r * t.dy;
      for (let q = 0; q < t.cols; q++) {
        const gc = j * t.cols + q; if (gc % stride) continue;
        const lon = t.x0 + q * t.dx;
        const v = t.v[r * t.cols + q]; if (!isFinite(v) || v > 3) continue;
        const pt = map.project([lon, lat]); if (pt.x < 14 || pt.y < 80 || pt.x > W - 90 || pt.y > H - 14) continue;
        const wk = gr * 1000000 + gc; let wet = waterCache.get(wk);
        if (wet === undefined) { // nur im Wasser (Deiche/Marsch ausschließen); „trocken“ erst merken, wenn die Kartenkacheln geladen sind
          wet = map.queryRenderedFeatures(pt, { layers: ['water'] }).length > 0;
          if (wet || tilesReady) waterCache.set(wk, wet);
        }
        if (!wet) continue;
        const tk = `${Math.round(lat * 20)}:${Math.round(lon * 20)}`; // Tide je ~3-km-Feld einmal rechnen
        if (!tideCache.has(tk)) tideCache.set(tk, nokKm({ lat, lon }) != null ? 'nok' : tideAt({ lat, lon }));
        const td = tideCache.get(tk);
        if (!td || td === 'nok') continue; // im Kanal keine Daten; ohne nahen Pegel keine (falschen) Zahlen
        const d = td.h - v;
        if (d < 0.1) continue;
        f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { t: d < 10 ? de(d, 1) : String(Math.round(d)), c: sndClass(d) } });
        if (f.length >= 900) break scan;
      }
    }
  }
  src.setData(FC(f));
  if (waterCache.size > 200000) waterCache.clear();
}

/* ---- Anzeige ---- */
function renderTideStrip() {
  const el = $('#iTide'), p = own || lastOwn || null;
  if (!p || !S.tideStrip) { el.hidden = true; return; }
  const km = nokKm(p);
  if (km != null && TIDE.nok.length) { // im Kanal: Kanalpegel statt Tide
    const n = TIDE.nok.slice().sort((a, b) => Math.abs(a.km - km) - Math.abs(b.km - km))[0];
    $('#tideCap').textContent = `Kanal · ${n.name}`; $('#vTide').textContent = `${n.nhn >= 0 ? '+' : ''}${de(n.nhn / 100, 2)}`; $('#vTideU').textContent = 'm NHN'; $('#vTideSub').textContent = '';
    el.hidden = false; return;
  }
  const t = tideAt(p); if (!t) { el.hidden = true; return; }
  const tr = trendOf(t.g), nx = nextEvents(t.g, 1)[0];
  $('#tideCap').textContent = `Tide · ${t.src === 'gemessen' ? 'gemessen' : 'Vorhersage'}`;
  $('#vTide').textContent = de(t.h, 1); $('#vTideU').textContent = `m ${tr > 1 ? '↗' : tr < -1 ? '↘' : '→'}`;
  $('#vTideSub').textContent = nx ? `${nx.ty} ${hm(nx.t)}` : '';
  el.hidden = false;
}
function tideCurveSvg(g) {
  const now = Date.now(), t0 = now - 6 * 3600e3, t1 = now + 18 * 3600e3, pts = [];
  let lo = 1e9, hi = -1e9;
  for (let t = t0; t <= t1; t += 10 * 60e3) { const h = predAt(g, t); if (h == null) continue; pts.push([t, h]); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  if (pts.length < 3) return '';
  const meas = g.now?.meas; if (meas != null) { lo = Math.min(lo, meas); hi = Math.max(hi, meas); }
  lo = Math.min(lo, 0); const W = 380, H = 130, pad = 18;
  const X = (t) => pad + (t - t0) / (t1 - t0) * (W - 2 * pad), Y = (h) => H - 22 - (h - lo) / (hi - lo || 1) * (H - 40);
  const path = pts.map(([t, h], i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)} ${Y(h).toFixed(1)}`).join('');
  const ev = (g.ev || []).filter((e) => e.t >= t0 && e.t <= t1);
  const hours = []; for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3 * 3600e3) hours.push(t);
  return `<svg class="tcurve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tidenkurve">
    <line x1="${pad}" x2="${W - pad}" y1="${Y(0)}" y2="${Y(0)}" class="ax"/><text x="${W - pad}" y="${Y(0) - 4}" class="lb" text-anchor="end">SKN</text>
    ${hours.map((t) => `<line x1="${X(t)}" x2="${X(t)}" y1="${H - 20}" y2="${H - 16}" class="ax"/><text x="${X(t)}" y="${H - 4}" class="lb" text-anchor="middle">${hm(t)}</text>`).join('')}
    <path d="${path}" class="pr"/>
    ${ev.map((e) => `<circle cx="${X(e.t)}" cy="${Y(e.h)}" r="3" class="ev"/><text x="${X(e.t)}" y="${Y(e.h) + (e.ty === 'HW' ? -7 : 14)}" class="lb" text-anchor="middle">${e.ty} ${hm(e.t)}</text>`).join('')}
    <line x1="${X(now)}" x2="${X(now)}" y1="8" y2="${H - 20}" class="now"/>
    ${meas != null ? `<circle cx="${X(now)}" cy="${Y(meas)}" r="5" class="me"/>` : ''}
  </svg>`;
}
function renderTide(full) {
  const p = own || lastOwn || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const gs = TIDE.gauges.slice().sort((a, b) => distM(p, a) - distM(p, b)), g = gs.find((x) => x.id === tideSel) || gs[0];
  $('#dTitle').textContent = 'Gezeiten & Tiefe';
  if (!full && Date.now() - drawerTouch < 1500) return;
  const km = nokKm(p);
  let html = '';
  if (km != null && TIDE.nok.length) {
    html += `<div class="status">Du bist im <b>Nord-Ostsee-Kanal</b> (km ${de(km, 1)}). Der Kanal hat keine Tide; der Wasserstand wird geregelt und schwankt meist nur um wenige Dezimeter um NHN. Solltiefe der Fahrrinne: 11 m.</div>
      <div class="group cap">Kanalpegel jetzt</div><dl class="kv">${TIDE.nok.map((n) => `<dt>${esc(n.name)} <small>km ${de(n.km, 1)}</small></dt><dd>${n.nhn >= 0 ? '+' : ''}${de(n.nhn / 100, 2)} m NHN</dd>`).join('')}</dl>`;
  }
  if (g) {
    const L = levelOf(g), nx = nextEvents(g, 4), ago = g.now?.measT ? fmtAge(Date.now() - g.now.measT) : null;
    html += `<div class="sub">Pegel <b>${esc(g.name)}</b> · ${nmTxt(distM(p, g))} entfernt</div>
      <div class="hero"><div><span class="cap">Jetzt ü. SKN</span><b>${L ? de(L.h / 100, 2) : '–'}<i>m</i></b></div>
        <div><span class="cap">Vorhersage BSH</span><b>${predAt(g, Date.now()) != null ? de(predAt(g, Date.now()) / 100, 2) : '–'}<i>m</i></b></div>
        <div class="${Math.abs(g.now?.surge || 0) >= 50 ? 'dg' : ''}"><span class="cap">Windstau</span><b>${g.now?.surge != null ? mTxt(g.now.surge, true).replace(' m', '<i>m</i>') : '–'}</b></div></div>
      <p class="note">${L?.src === 'gemessen' ? `Gemessen am Pegel vor ${ago} (PEGELONLINE).` : 'Keine aktuelle Messung – Wert aus der amtlichen Vorausberechnung.'} Windstau = Messung minus Vorhersage (BSH-Tidenkurve). Positiv = mehr Wasser als vorhergesagt.</p>
      ${tideCurveSvg(g)}
      <div class="group cap">Tidenkalender (BSH-Vorausberechnung)</div>
      <dl class="kv">${nx.map((e) => `<dt>${e.ty === 'HW' ? 'Hochwasser' : 'Niedrigwasser'} · ${new Date(e.t).toLocaleDateString('de-DE', { weekday: 'short' })}</dt><dd>${hm(e.t)} ${tz()} · ${de(e.h / 100, 2)} m</dd>`).join('')}</dl>
      ${gs.length > 1 ? `<div class="filters" id="tgs">${gs.map((x) => `<button data-g="${x.id}" class="${x === g ? 'on' : ''}">${esc(x.name.split(',')[0])}</button>`).join('')}</div>` : ''}`;
  } else if (km == null) html += `<div class="empty"><b>Kein Gezeitenpegel in der Nähe</b>Gezeiten gibt es für die deutsche Nordseeküste, die Tideelbe und die Kieler Förde.</div>`;
  if (full) {
    html += `<div class="group cap">Tiefenpunkte auf der Karte</div>
      ${tog('iDepthPts', S.depthPts, 'Aktuelle Wassertiefe anzeigen', 'Kleine Punkte mit der Tiefe jetzt (Kartentiefe + Tide), ab mittlerer Zoomstufe')}
      ${tog('iTideStrip', S.tideStrip, 'Tide oben in der Leiste')}
      <div class="row"><div class="lbl"><b>Tiefgang eigenes Schiff</b><small>0 = keine Einfärbung nach Tiefgang</small></div><input class="field" id="iDraught" inputmode="decimal" value="${de(S.draught, 1)}"><span class="unit">m</span></div>
      <div class="row"><div class="lbl"><b>Sicherheitsabstand unterm Kiel</b></div><input class="field" id="iUkc" inputmode="decimal" value="${de(S.ukc, 1)}"><span class="unit">m</span></div>
      <div class="legend snd"><div><i class="dot shoal"></i>zu flach${S.draught > 0 ? ` (unter ${de(S.draught + S.ukc, 1)} m)` : ' (unter 2 m)'}</div><div><i class="dot warn"></i>knapp${S.draught > 0 ? ` (+1 m)` : ' (2–5 m)'}</div><div><i class="dot safe"></i>ausreichend</div></div>
      <p class="note">Kartentiefen: EMODnet Bathymetry (Raster ≈ 115 m, bezogen auf LAT/Seekartennull). Fahrrinnen werden gebaggert und verlagern sich – aktuelle Peilungen und amtliche Seekarte gehen vor. <b>Nicht zur Navigation.</b></p>`;
    dBody.innerHTML = `<div id="tideTop"></div>` + html.slice(html.indexOf('<div class="group cap">Tiefenpunkte'));
    $('#tideTop').innerHTML = html.slice(0, html.indexOf('<div class="group cap">Tiefenpunkte'));
    $('#iDepthPts').onchange = (e) => { S.depthPts = e.target.checked; save(); renderSoundings(); };
    $('#iTideStrip').onchange = (e) => { S.tideStrip = e.target.checked; save(); };
    const num = (id, k) => { $(id).onchange = (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (isFinite(v) && v >= 0 && v < 30) { S[k] = v; save(); renderSoundings(); renderTide(true); } else e.target.value = de(S[k], 1); }; };
    num('#iDraught', 'draught'); num('#iUkc', 'ukc');
  } else $('#tideTop').innerHTML = html;
  $('#tgs')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { tideSel = b.dataset.g; renderTide(true); } });
}
let tideSel = null;

/* ================= Seitenfach ================= */
let drawer = null, drawerTouch = 0;
const dBody = $('#dBody');
dBody.addEventListener('pointerdown', () => { drawerTouch = Date.now(); }, { passive: true });
dBody.addEventListener('scroll', () => { drawerTouch = Date.now(); }, { passive: true });
function openDrawer(mode) {
  if (drawer === mode && mode !== 'ship') { closeDrawer(); return; }
  drawer = mode; $('#drawer').hidden = false; document.body.classList.add('dopen');
  for (const [id, m] of [['#tList', 'list'], ['#tLayers', 'layers'], ['#tSettings', 'settings']]) $(id).classList.toggle('on', m === mode);
  renderDrawer(true);
}
function closeDrawer() {
  if (drawer === 'ship') { selected = null; }
  drawer = null; $('#drawer').hidden = true; document.body.classList.remove('dopen'); ['#tList', '#tLayers', '#tSettings'].forEach((i) => $(i).classList.remove('on'));
}
$('#dClose').onclick = closeDrawer;
const tog = (id, on, label, hint = '') => `<div class="row"><div class="lbl"><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</div><label class="toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label></div>`;
let listQ = '', listF = 'all';
function renderDrawer(full) {
  if (!drawer) return;
  if (drawer === 'list') return renderList(full);
  if (drawer === 'ship') return renderShip(full);
  if (drawer === 'layers') return full && renderLayers();
  if (drawer === 'settings') return renderSettings(full);
  if (drawer === 'tide') return renderTide(full);
}
function renderList(full) {
  if (full) {
    $('#dTitle').textContent = 'Schiffe in der Umgebung';
    dBody.innerHTML = `<div class="search"><input type="search" id="q" placeholder="Name, MMSI, Rufzeichen oder Zielhafen" value="${esc(listQ)}" autocomplete="off" spellcheck="false"></div>
      <div class="filters">${[['all', 'Alle'], ['moving', 'In Fahrt'], ['danger', 'Annäherung'], ['big', 'Über 50 m']].map(([k, l]) => `<button data-f="${k}" class="${listF === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="ql"></div>`;
    $('#q').oninput = (e) => { listQ = e.target.value; renderList(false); };
    dBody.querySelectorAll('.filters button').forEach((b) => b.onclick = () => { listF = b.dataset.f; renderList(true); });
    $('#ql').onclick = (e) => { const el = e.target.closest('.vsl'); if (!el) return; const t = ships.get(+el.dataset.m); if (!t) return; setFollow(false); select(t.m); map.easeTo({ center: ll(t.p || { lat: t.la, lon: t.lo }), zoom: Math.max(map.getZoom(), 13), duration: 700 }); };
  }
  const q = listQ.trim().toUpperCase(), ownM = +S.mmsi, C = CATCOL[theme];
  const hit = (t) => !q || [t.n, t.cs, t.dst, t.imo, t.m].some((v) => v != null && String(v).toUpperCase().includes(q));
  let arr = [...ships.values()].filter((t) => t.la != null && t.m !== ownM && hit(t));
  if (listF === 'moving') arr = arr.filter((t) => t.s >= 0.5); if (listF === 'danger') arr = arr.filter((t) => t.dg); if (listF === 'big') arr = arr.filter((t) => t.A + t.B >= 50);
  arr.sort((a, b) => (b.dg - a.dg) || ((a.dist ?? 1e12) - (b.dist ?? 1e12)) || (a.n || '').localeCompare(b.n || ''));
  const st = aisState.state;
  $('#ql').innerHTML = arr.length ? arr.slice(0, 300).map((t) => `<div class="vsl ${t.dg ? 'danger' : ''}" data-m="${t.m}">${triSvg(C[cat(t.ty)], t.dg)}
      <div class="nm"><b>${esc(t.n || 'MMSI ' + t.m)}</b><span>${typeTxt(t.ty)} · ${t.s >= 0.5 ? spd(t.s) + ' ' + spdU() : (NAVST[t.st] || 'liegt')}${t.dst ? ' · nach ' + esc(t.dst) : ''}</span></div>
      <div class="ds">${t.dist != null ? nmTxt(t.dist) : '–'}<span>${t.tcpa > 0 && t.tcpa < 3600 && t.s >= 0.5 ? 'CPA ' + nmTxt(t.cpa) : t.brg != null ? p3(t.brg) + '°' : ''}</span></div></div>`).join('')
    : `<div class="empty">${st === 'nokey' ? '<b>Kein gültiger AIS-Schlüssel</b>Ohne Schlüssel kommen keine Schiffsdaten an.' : st === 'rejected' ? '<b>AIS-Zugang gerade belegt</b>Zu viele Geräte gleichzeitig verbunden. Neuer Versuch läuft automatisch.' : q || listF !== 'all' ? '<b>Keine Treffer</b>Suche oder Filter ändern.' : '<b>Noch keine Schiffe empfangen</b>Liegende Schiffe melden sich nur alle paar Minuten.'}</div>`;
}
function select(m) {
  selected = m; drawer = 'ship'; $('#drawer').hidden = false; document.body.classList.add('dopen');
  ['#tList', '#tLayers', '#tSettings'].forEach((i) => $(i).classList.remove('on'));
  renderShip(true); render();
}
function renderShip() {
  const t = ships.get(selected); if (!t) { closeDrawer(); return; }
  const now = Date.now(), len = t.A + t.B, wid = t.C + t.D, isOwn = +S.mmsi === t.m, C = CATCOL[theme], hasOwn = own && !isOwn && t.dist != null;
  $('#dTitle').textContent = t.n || `MMSI ${t.m}`;
  const kmT = nokKm({ lat: t.la, lon: t.lo }), fl = flag(t.m);
  const hero = hasOwn
    ? `<div><span class="cap">Abstand</span><b>${nmTxt(t.dist).replace(/ (\S+)$/, '<i>$1</i>')}</b></div>
       <div class="${t.dg ? 'dg' : ''}"><span class="cap">CPA</span><b>${t.tcpa > 0 ? nmTxt(t.cpa).replace(/ (\S+)$/, '<i>$1</i>') : '<small>entfernt sich</small>'}</b></div>
       <div class="${t.dg ? 'dg' : ''}"><span class="cap">TCPA</span><b>${t.tcpa > 0 && t.tcpa < 6 * 3600 ? Math.max(1, Math.round(t.tcpa / 60)) + '<i>min</i>' : '–'}</b></div>`
    : `<div><span class="cap">Fahrt</span><b>${spd(t.s)}<i>${spdU()}</i></b></div><div><span class="cap">Kurs · COG</span><b>${t.c != null ? p3(t.c) + '<i>°</i>' : '–'}</b></div><div><span class="cap">Voraus · HDG</span><b>${t.h != null ? p3(t.h) + '<i>°</i>' : '–'}</b></div>`;
  const rows = [];
  const rs = relSide(own, t.brg), ps = t.tcpa > 0 && t.tcpa < 3600 ? passSide(t) : '';
  if (hasOwn) rows.push(['Peilung', `${p3(t.brg)}°${rs ? ' · ' + rs : ''}`], ...(ps ? [['Passage', ps]] : []), ['Fahrt · SOG', `${spd(t.s)} ${spdU()}`], ['Kurs · COG', t.c != null ? `${p3(t.c)}°` : '–'], ['Voraus · HDG', t.h != null ? `${p3(t.h)}°` : '–']);
  if (t.r != null) rows.push(['Drehrate', rotTxt(t.r)]);
  if (kmT != null) rows.push(['NOK-km', de(kmT, 1)]);
  rows.push(['Status', NAVST[t.st] || '–'], ['Ziel', esc(t.dst || '–')], ['ETA', etaTxt(t.eta)], ['Länge × Breite', len > 0 ? `${len} × ${wid || '?'} m` : '–'], ['Tiefgang', t.dr ? `${de(t.dr, 1)} m` : '–'],
    ['Flagge', fl || '–'], ['Rufzeichen', esc(t.cs || '–')], ['MMSI', t.m], ['IMO', t.imo || '–'], ['AIS-Klasse', t.b ? 'B (Sportboot/klein)' : 'A (Berufsschifffahrt)'], ['Position', `${dm(t.la, true)}<br>${dm(t.lo, false)}`], ['Letzte Meldung', `vor ${fmtAge(now - t.ts)}`]);
  dBody.innerHTML = `<div class="sub"><span class="sw" style="background:${C[cat(t.ty)]}"></span>${typeTxt(t.ty)}${t.st != null && NAVST[t.st] ? ' · ' + NAVST[t.st] : ''}</div>
    <div class="hero">${hero}</div><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="actions"><button class="btn pri" id="sCenter"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4" class="f"/></svg>Auf Karte zeigen</button>
    ${isOwn ? '<span class="note">Das ist dein eigenes Schiff.</span>' : '<button class="btn" id="sOwn">Ist mein Schiff</button>'}${navigator.share ? '<button class="btn" id="sShare">Teilen</button>' : ''}</div>`;
  const sh = $('#sShare'); if (sh) sh.onclick = () => navigator.share({ title: t.n || `MMSI ${t.m}`, text: `${t.n || 'Schiff'} (MMSI ${t.m}) · ${dm(t.la, true)} ${dm(t.lo, false)} · ${spd(t.s)} ${spdU()} · ${typeTxt(t.ty)}`, url: `${location.origin}${location.pathname}#ship=${t.m}` }).catch(() => {});
  $('#sCenter').onclick = () => { setFollow(false); map.easeTo({ center: ll(t.p || { lat: t.la, lon: t.lo }), zoom: Math.max(map.getZoom(), 14), duration: 700 }); };
  const so = $('#sOwn'); if (so) so.onclick = () => ask(`<b>${esc(t.n || t.m)}</b> (MMSI ${t.m}) als eigenes Schiff festlegen?`, 'Festlegen').then((y) => { if (y) { S.mmsi = String(t.m); if (S.source === 'gps') S.source = 'fused'; save(); closeDrawer(); toast('Eigenes Schiff gespeichert'); } });
}
function legendHtml() {
  const C = CATCOL[theme];
  return CATS.map((k) => `<div>${triSvg(C[k])}${CAT_TXT[k]}</div>`).join('') +
    `<div><svg viewBox="-14 -14 28 28"><circle r="6" fill="${C.cargo}" stroke="#1b1f22" stroke-width="1.2"/></svg>liegt (ohne Kurs)</div><div><svg viewBox="-14 -14 28 28" style="opacity:.4">${triSvg(C.cargo).replace(/<\/?svg[^>]*>/g, '')}</svg>lange keine Meldung</div>`;
}
function renderLayers() {
  $('#dTitle').textContent = 'Kartenansicht';
  dBody.innerHTML = `<div class="group cap">Grundkarte</div>
    <div class="seg" id="segBase"><button data-v="0" class="${!S.sat ? 'on' : ''}">Seekarte<small>Vektor, klar</small></button><button data-v="1" class="${S.sat ? 'on' : ''}">Satellit<small>Luftbild</small></button></div>
    <div class="group cap">Auf der Karte</div>
    ${tog('lSea', S.seamarks, 'Seezeichen', 'Tonnen, Leuchtfeuer, Fahrwasser (OpenSeaMap)')}
    ${tog('lDepth', S.depth, 'Wassertiefen', 'Grobe Tiefenfarben (EMODnet) – nicht zur Navigation')}
    ${tog('lRings', S.rings, 'Abstandsringe', 'Um das eigene Schiff, passen sich dem Zoom an')}
    ${tog('lTrack', S.track, 'Eigener Track', 'Gefahrene Strecke der letzten 3 Stunden')}
    ${tog('lLabels', S.labels, 'Schiffsnamen', 'Ab mittlerer Zoomstufe')}
    ${tog('lDepthPts', S.depthPts, 'Tiefenpunkte (Tiefe jetzt)', 'Kartentiefe + aktuelle Tide, ab mittlerer Zoomstufe')}
    <div class="row"><div class="lbl"><b>Gezeiten & Tiefgang</b><small>Tidenkurve, Hoch-/Niedrigwasser, Windstau</small></div><button class="btn" id="bTide">Öffnen</button></div>
    <div class="group cap">Schiffe</div>
    ${tog('lB', S.showB, 'Kleine Fahrzeuge (Klasse B)', 'Sportboote und kleine Berufsfahrzeuge')}
    ${tog('lMoored', S.showMoored, 'Liegende Schiffe', 'Festgemacht oder vor Anker')}
    <div class="group cap">Farben</div><div class="legend">${legendHtml()}</div>`;
  dBody.querySelectorAll('#segBase button').forEach((b) => b.onclick = () => { S.sat = b.dataset.v === '1'; save(); applyLayers(); renderLayers(); });
  const bind = (id, k) => { $(id).onchange = (e) => { S[k] = e.target.checked; save(); applyLayers(); render(); }; };
  $('#lDepthPts').onchange = (e) => { S.depthPts = e.target.checked; save(); renderSoundings(); };
  $('#bTide').onclick = () => openDrawer('tide');
  bind('#lSea', 'seamarks'); bind('#lDepth', 'depth'); bind('#lRings', 'rings'); bind('#lTrack', 'track'); bind('#lLabels', 'labels'); bind('#lB', 'showB'); bind('#lMoored', 'showMoored');
}
function srcStatusHtml() {
  const now = Date.now(), g = gps && now - gps.t < 300000, oa = S.mmsi ? ships.get(+S.mmsi) : null, oaF = oa && oa.la != null && now - oa.ts < 600000;
  return `<div class="status">GPS im Tablet: ${g ? `<b class="ok">empfängt</b> · ± ${Math.round(gps.acc)} m` : `<b class="warn">${gpsErr || 'noch kein Signal'}</b>`}<br>
    AIS des eigenen Schiffs: ${!S.mmsi ? '<b class="warn">keine MMSI eingetragen</b>' : oaF ? `<b class="ok">empfängt</b> · ${esc(oa.n || S.mmsi)}, vor ${fmtAge(now - oa.ts)}` : '<b class="warn">noch nicht empfangen</b>'}
    ${own && own.src === 'GPS+AIS' ? `<br>Abstand GPS ↔ AIS: <b>${Math.round(own.diff)} m</b> · Gewichtung GPS ${own.wG} % / AIS ${100 - own.wG} %` : ''}</div>`;
}
function aisStatusHtml() {
  const st = aisState.state, n = [...ships.values()].filter((t) => t.la != null).length;
  let txt;
  if (st === 'demo') txt = '<b class="warn">Demo aktiv</b> – die Schiffe sind erfunden.';
  else if (st === 'nokey') txt = '<b class="bad">AIS-Schlüssel ungültig.</b> Bitte beim Einrichter melden.';
  else if (st === 'rejected') txt = '<b class="bad">AIS-Zugang belegt</b> (außerhalb des Sammelgebiets nur 3 gleichzeitige Verbindungen). Neuer Versuch automatisch.';
  else if (st === 'outside') txt = '<b class="warn">Außerhalb des AIS-Sammelgebiets</b> (Deutsche Bucht, Elbe, Nord-Ostsee-Kanal, Kieler Bucht). Karte zurück in dieses Gebiet schieben.';
  else if (st === 'offline') txt = `<b class="bad">Kein Internet.</b> ${n} Schiffe bleiben auf ihren letzten Positionen, bis die Verbindung zurück ist.`;
  else if (linkOk()) txt = `<b class="ok">Verbunden</b> · ${n} Schiffe · ${relayMode === 'cache' ? 'Sammeldienst Elbe/NOK/Kieler Bucht' + (collectorOk ? '' : ' <b class="warn">(Quelle gestört)</b>') : 'direkte AIS-Verbindung'}`;
  else if (lostAt) txt = `<b class="warn">Verbindung unterbrochen</b> seit ${fmtAge(Date.now() - lostAt)} – baut sich automatisch neu auf. ${n} Schiffe werden solange gehalten.`;
  else txt = '<b class="warn">Verbinde …</b>';
  return `<div class="status">${txt}</div>`;
}
function renderSettings(full) {
  if (full) {
    $('#dTitle').textContent = 'Einstellungen';
    dBody.innerHTML = `<div class="group cap">Eigene Position</div>
      <div class="seg" id="segSrc">${[['fused', 'Kombiniert', 'GPS + AIS'], ['gps', 'GPS', 'vom Tablet'], ['ais', 'AIS', 'vom Schiff']].map(([v, l, s]) => `<button data-v="${v}" class="${S.source === v ? 'on' : ''}">${l}<small>${s}</small></button>`).join('')}</div>
      <div class="row"><div class="lbl"><b>MMSI des eigenen Schiffs</b><small>9 Ziffern – im AIS-Gerät (Menü „Own Ship“) oder in der Frequenzzuteilungsurkunde</small></div><input class="field wide" id="iMmsi" inputmode="numeric" maxlength="9" value="${esc(S.mmsi)}" placeholder="211…" autocomplete="off"></div>
      <div id="srcStat"></div>
      <div class="group cap">Kollisionswarnung</div>
      ${tog('iAlarm', S.alarm, 'Warnung bei Annäherung', 'Hinweis oben, rote Markierung, Ton')}
      <div class="seg" id="segProf">${Object.entries(PROFILES).map(([k, v]) => `<button data-v="${k}" class="${S.profile === k ? 'on' : ''}">${v.t}<small>${de(v.cpa, 2)} sm · ${v.tcpa} min</small></button>`).join('')}</div>
      <div class="row"><div class="lbl"><b>Näher als</b><small>engster Abstand (CPA)</small></div><input class="field" id="iCpa" inputmode="decimal" value="${de(S.cpaNm, 2)}"><span class="unit">sm</span></div>
      <div class="row"><div class="lbl"><b>Innerhalb von</b><small>Zeit bis dahin (TCPA)</small></div><input class="field" id="iTcpa" inputmode="numeric" value="${S.tcpaMin}"><span class="unit">min</span></div>
      <div class="row"><div class="lbl"><b>Warnton</b><small>Dreifach-Piepton, wiederholt bei neuer Gefahr</small></div><button class="btn" id="bTest">Testen</button><label class="toggle"><input type="checkbox" id="iSound" ${S.sound ? 'checked' : ''}><i></i></label></div>
      <div class="group cap">Anzeige</div>
      <div class="seg" id="segUnits"><button data-v="sea" class="${S.units === 'sea' ? 'on' : ''}">Seemeilen · Knoten<small>sm · kn</small></button><button data-v="inland" class="${S.units === 'inland' ? 'on' : ''}">Kilometer · km/h<small>Kanal / Binnen</small></button></div>
      <div class="row"><div class="lbl"><b>Vorauslinie</b><small>Länge der Kurslinie vor jedem Schiff</small></div><input class="field" id="iVec" inputmode="numeric" value="${S.vecMin}"><span class="unit">min</span></div>
      ${tog('iWake', S.wake, 'Bildschirm anlassen', 'Solange die Seekarte offen ist')}
      <div class="row"><div class="lbl"><b>Eigenen Track löschen</b></div><button class="btn" id="bClr">Löschen</button></div>
      <div class="group cap">AIS-Empfang</div><div id="aisStat"></div>
      <div class="row"><div class="lbl"><b>Einrichtung wiederholen</b><small>Assistent vom ersten Start</small></div><button class="btn" id="bOnb">Starten</button></div>
      <details class="expert"><summary class="group cap">Für Fachleute</summary>
        ${tog('iDemo', S.demo, 'Demo-Modus', 'Erfundene Schiffe zum Ausprobieren – nicht echt')}
        <div class="status" id="rawStat"></div>
        <p class="note">Einrichtungs-Link für ein weiteres Tablet: <b>${esc(location.origin + location.pathname)}#mmsi=${esc(S.mmsi || '211XXXXXX')}&amp;src=${S.source}</b></p>
      </details>
      <p class="note" style="margin-top:18px">Seekarte Live ${VERSION}. Einstellungen bleiben nur auf diesem Gerät. Hilfsmittel, kein zugelassenes Navigationsgerät.</p>`;
    dBody.querySelectorAll('#segSrc button').forEach((b) => b.onclick = () => { S.source = b.dataset.v; save(); renderSettings(true); });
    dBody.querySelectorAll('#segProf button').forEach((b) => b.onclick = () => { const pr = PROFILES[b.dataset.v]; S.profile = b.dataset.v; S.cpaNm = pr.cpa; S.tcpaMin = pr.tcpa; save(); renderSettings(true); });
    dBody.querySelectorAll('#segUnits button').forEach((b) => b.onclick = () => { S.units = b.dataset.v; save(); renderSettings(true); render(); });
    $('#iMmsi').onchange = (e) => { const v = e.target.value.replace(/\D/g, ''); if (v && v.length !== 9) { toast('Eine MMSI hat genau 9 Ziffern'); e.target.value = S.mmsi; return; } S.mmsi = v; save(); toast(v ? 'MMSI gespeichert' : 'MMSI entfernt'); };
    const num = (id, k, min, max, d) => { $(id).onchange = (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (isFinite(v)) { S[k] = Math.min(max, Math.max(min, v)); save(); } e.target.value = d ? de(S[k], d) : S[k]; }; };
    num('#iCpa', 'cpaNm', 0.02, 5, 2); num('#iTcpa', 'tcpaMin', 1, 60); num('#iVec', 'vecMin', 1, 60);
    for (const id of ['#iCpa', '#iTcpa']) $(id).addEventListener('change', () => { S.profile = Object.keys(PROFILES).find((k) => PROFILES[k].cpa === S.cpaNm && PROFILES[k].tcpa === S.tcpaMin) || ''; save(); dBody.querySelectorAll('#segProf button').forEach((x) => x.classList.toggle('on', x.dataset.v === S.profile)); });
    $('#iAlarm').onchange = (e) => { S.alarm = e.target.checked; save(); };
    $('#iSound').onchange = (e) => { S.sound = e.target.checked; save(); };
    $('#bTest').onclick = () => beep(true);
    $('#iWake').onchange = (e) => { S.wake = e.target.checked; save(); wake(); };
    $('#bClr').onclick = () => { ownTrack = []; toast('Track gelöscht'); };
    $('#iDemo').onchange = (e) => { S.demo = e.target.checked; save(); if (S.demo) { disconnect(); startDemo(); } else { stopDemo(); aisState = { state: 'off' }; wsRetry = 1000; connect(); } };
    $('#bOnb').onclick = () => { closeDrawer(); onboarding(0); };
  }
  $('#srcStat').innerHTML = srcStatusHtml();
  $('#aisStat').innerHTML = aisStatusHtml();
  const rs = $('#rawStat'); if (rs) rs.textContent = `Relay-Status: ${aisState.state}${aisState.detail ? ' (' + aisState.detail + ')' : ''} · letzte Meldung vor ${lastMsg ? fmtAge(Date.now() - lastMsg) : '–'} · ${ships.size} Ziele im Speicher`;
}
$('#tList').onclick = () => openDrawer('list');
$('#tLayers').onclick = () => openDrawer('layers');
$('#tSettings').onclick = () => openDrawer('settings');
$('#cAis').onclick = () => openDrawer('settings');
$('#iTide').onclick = () => openDrawer('tide');

/* ================= Bestätigen ================= */
function ask(text, ok = 'OK', danger = false) {
  return new Promise((res) => {
    modal(`<div class="mscroll" style="padding-top:22px"><p style="font-size:18px">${text}</p></div>
      <div class="mfoot"><span class="grow"></span><button class="btn" data-no>Abbrechen</button><button class="btn pri ${danger ? 'dangerbtn' : ''}" data-yes>${ok}</button></div>`);
    $('#mBody [data-no]').onclick = () => { closeModal(); res(false); };
    $('#mBody [data-yes]').onclick = () => { closeModal(); res(true); };
  });
}

/* ================= Hinweis-Toast ================= */
let toastTimer = null;
function toast(t, onClick) { const el = $('#toast'); el.textContent = t; el.hidden = false; el.onclick = onClick || (() => { el.hidden = true; }); clearTimeout(toastTimer); if (!onClick) toastTimer = setTimeout(() => { el.hidden = true; }, 3200); }

/* ================= Hilfe + Einrichtungsassistent ================= */
function modal(html) { $('#mBody').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').onclick = (e) => { if (e.target.id === 'modal' && S.onboarded) closeModal(); };
const X = '<button class="close" type="button" data-x aria-label="Schließen"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
function onboarding(step) {
  const N = 4, steps = `<div class="steps">${Array.from({ length: N }, (_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  const foot = (next = 'Weiter') => `<div class="mfoot">${steps}<span class="grow"></span>${step ? '<button class="btn" data-back>Zurück</button>' : ''}<button class="btn pri" data-next>${next}</button></div>`;
  if (step === 0) {
    modal(`<div class="mscroll"><div class="brand"><img src="icon-180.png" alt=""><div><h1>Seekarte Live</h1><p>Das AIS-Lagebild rund ums Schiff.</p></div></div>
      <p>Die Seekarte zeigt dir <b>die Schiffe in deiner Umgebung live über AIS</b>, dein eigenes Schiff – und warnt, wenn dir eines zu nahe kommt.</p>
      <p>Drei kurze Fragen, dann geht's los.</p>
      <div class="warn">Hilfsmittel für den Überblick – <b>kein zugelassenes Navigationsgerät</b>. Die Schiffsdaten kommen über das Internet von Landstationen, mit einigen Sekunden Verzögerung, und nicht jedes Schiff wird empfangen.</div>
      <label class="ack"><input type="checkbox" id="oAck" ${S.onboarded ? 'checked' : ''}><span>Verstanden – ich nutze die Seekarte nur ergänzend zu Ausguck, Radar und amtlicher Karte.</span></label></div>${foot()}`);
  } else if (step === 1) {
    const ch = (v, ico, t, sub) => `<button data-v="${v}" class="${S.source === v ? 'on' : ''}">${ico}<b>${t}</b><small>${sub}</small></button>`;
    modal(`<div class="mhead"><h2>Woher kommt deine Position?</h2></div><div class="mscroll">
      <div class="choice" id="chSrc">
        ${ch('fused', '<svg viewBox="0 0 24 24"><circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/></svg>', 'Kombiniert (empfohlen)', 'GPS des Tablets und AIS deines Schiffs werden gemittelt. Fällt eins aus, läuft das andere weiter.')}
        ${ch('gps', '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/></svg>', 'Nur GPS vom Tablet', 'Braucht ein Tablet mit GPS (iPad nur mit SIM-Karte).')}
        ${ch('ais', '<svg viewBox="0 0 24 24"><path d="M12 3 18 18 12 15 6 18Z"/><path d="M4 8a10 10 0 0 1 3-4M20 8a10 10 0 0 0-3-4"/></svg>', 'Nur AIS vom Schiff', 'Wenn das Tablet kein GPS hat. MMSI nötig.')}
      </div>
      <div class="row" style="border:0"><div class="lbl"><b>MMSI deines Schiffs</b><small>9 Ziffern – im AIS-Gerät (Menü „Own Ship“) oder in der Frequenzzuteilungsurkunde. Für „Kombiniert“ und „AIS“.</small></div><input class="field wide" id="oMmsi" inputmode="numeric" maxlength="9" value="${esc(S.mmsi)}" placeholder="211…" autocomplete="off"></div>
      </div>${foot()}`);
    $('#chSrc').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.source = b.dataset.v; save(); $('#chSrc').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
  } else if (step === 2) {
    const ch = (v, t, sub) => `<button data-v="${v}" class="${S.profile === v ? 'on' : ''}"><span class="num2">${v === 'canal' ? '55<i>m</i>' : de(PROFILES[v].cpa, 1) + '<i>sm</i>'}</span><b>${t}</b><small>${sub}</small></button>`;
    modal(`<div class="mhead"><h2>Wo bist du unterwegs?</h2></div><div class="mscroll">
      <p class="note">Danach richtet sich, ab wann die Kollisionswarnung anschlägt. Im Kanal passieren sich Schiffe planmäßig auf wenige Dutzend Meter – dort soll es nicht ständig piepen.</p>
      <div class="choice" id="chProf">
        ${ch('sea', 'See', 'Warnung unter 0,5 sm innerhalb von 15 min')}
        ${ch('river', 'Revier / Elbe', 'Warnung unter 0,2 sm innerhalb von 10 min')}
        ${ch('canal', 'Kanal', 'Warnung unter ca. 55 m innerhalb von 4 min · Anzeige in km und km/h')}
      </div>
      <div class="row"><div class="lbl"><b>Standort freigeben</b><small id="oGps">${gps ? 'GPS empfängt ✓' : 'Das Tablet fragt einmal nach – bitte „Erlauben“.'}</small></div><button class="btn" id="oLoc">Freigeben</button></div>
      <div class="row"><div class="lbl"><b>Warnton testen</b><small>Schaltet den Ton gleichzeitig frei.</small></div><button class="btn" id="oBeep">Ton testen</button></div>
      </div>${foot()}`);
    $('#chProf').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const pr = PROFILES[b.dataset.v]; S.profile = b.dataset.v; S.cpaNm = pr.cpa; S.tcpaMin = pr.tcpa; S.units = b.dataset.v === 'canal' ? 'inland' : 'sea'; save(); $('#chProf').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    $('#oLoc').onclick = () => navigator.geolocation?.getCurrentPosition(() => { $('#oGps').textContent = 'Standort freigegeben ✓'; }, (er) => { $('#oGps').textContent = er.code === 1 ? 'Abgelehnt – in den Tablet-Einstellungen für den Browser erlauben.' : 'Noch kein GPS-Signal.'; }, { enableHighAccuracy: true, timeout: 15000 });
    $('#oBeep').onclick = () => beep(true);
  } else {
    const ios = /iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
    const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
    modal(`<div class="mhead"><h2>${standalone ? 'Alles bereit' : 'Als App aufs Tablet legen'}</h2></div><div class="mscroll">
      ${standalone ? '<p>Die Seekarte läuft bereits als App. Gute Wache!</p>' : ios ? '<p><b>iPad:</b> In Safari auf <kbd>Teilen</kbd> tippen → <kbd>Zum Home-Bildschirm</kbd>. Danach startet die Seekarte wie eine App im Vollbild.</p>'
        : '<p><b>Android:</b> Im Chrome-Menü <kbd>⋮</kbd> → <kbd>App installieren</kbd> bzw. <kbd>Zum Startbildschirm hinzufügen</kbd>.</p><p><b>iPad:</b> In Safari <kbd>Teilen</kbd> → <kbd>Zum Home-Bildschirm</kbd>.</p>'}
      <p>Der Bildschirm bleibt an, solange die Seekarte offen ist. Alles Weitere erklärt der Knopf <kbd>Hilfe</kbd> rechts.</p></div>${foot('Seekarte öffnen')}`);
  }
  const mb = $('#mBody');
  mb.querySelector('[data-next]').addEventListener('click', () => {
    if (step === 0 && !$('#oAck').checked) { toast('Bitte den Hinweis bestätigen'); return; }
    if (step === 1) {
      const v = ($('#oMmsi').value || '').replace(/\D/g, '');
      if (v && v.length !== 9) { toast('Eine MMSI hat genau 9 Ziffern'); return; }
      if (!v && S.source === 'ais') { toast('Für „Nur AIS“ bitte die MMSI eintragen'); return; }
      S.mmsi = v; save();
    }
    if (step === N - 1) { S.onboarded = true; save(); closeModal(); wake(); return; }
    onboarding(step + 1);
  });
  mb.querySelector('[data-back]')?.addEventListener('click', () => onboarding(step - 1));
}
function help() {
  modal(`<div class="mhead"><h2>Hilfe</h2>${X}</div><div class="mscroll">
    <div class="quick"><h3>In 30 Sekunden</h3><ol>
      <li><b style="color:var(--own)">Das orange Schiff bist du.</b> Die bunten Dreiecke sind andere Schiffe – die Spitze zeigt die Fahrtrichtung, die Linie davor, wo das Schiff in ${S.vecMin} Minuten ist.</li>
      <li><b>Tippe ein Schiff an</b> für Name, Fahrt, Ziel und wie nah es dir kommt.</li>
      <li><b>Rot mit Piepen</b> heißt: Das Schiff kommt dir nahe. „Gesehen“ stoppt das Piepen.</li></ol></div>
    <h3>Warum fehlen manche Schiffe?</h3>
    <p>Die Schiffe kommen über das Internet von Empfangsstationen an Land – <b>nicht von deiner AIS-Anlage</b>. Nicht jedes Schiff wird empfangen, und Positionen kommen etwa alle 30–60 Sekunden (dazwischen rechnet die Karte mit Kurs und Fahrt weiter). Liegende Schiffe melden sich nur alle paar Minuten, Name und Typ bis zu 6 Minuten nach dem Öffnen – bis dahin ist ein Schiff grau. Zum Ausweichen gelten Radar und die eigene AIS-Anlage.</p>
    <h3>Symbole</h3><div class="legend">${legendHtml()}</div>
    <p class="note">Dreieck = fährt · kleines Dreieck mit Punkt = liegt (Spitze zeigt die Vorausrichtung) · Kreis = liegt, Richtung unbekannt · kleiner = Klasse B (Sportboot) · blass = seit 6 Minuten keine Meldung · rot mit Ring = kommt nahe. Nah herangezoomt erscheinen Schiffe in echter Größe.</p>
    <h3>Die Leiste oben</h3>
    <p><b>Fahrt · SOG</b> = Fahrt über Grund, <b>Kurs · COG</b> = Kurs über Grund, <b>Voraus · HDG</b> = wohin der Bug zeigt (nur über AIS). Dazu Position und Quelle: <b>GPS</b> (Tablet), <b>AIS</b> (dein Schiff) oder <b>GPS + AIS</b> gemittelt – dann zeigen zwei kleine Punkte die Einzelwerte (blau GPS, grün AIS). Im Nord-Ostsee-Kanal erscheint der <b>NOK-km</b>.</p>
    <h3>Knöpfe rechts</h3>
    <ul><li><b>Folgen</b> – Karte bleibt auf deinem Schiff; Verschieben beendet es, Tippen holt es zurück.</li>
    <li><b>Nord oben / Kurs oben</b> – Karte genordet oder in Fahrtrichtung gedreht.</li>
    <li><b>Schiffe</b> – Liste nach Entfernung, mit Suche (Name, MMSI, Rufzeichen, Zielhafen) und Filtern. Rote Zahl = Annäherungen.</li>
    <li><b>Karte</b> – Satellit, Seezeichen, Tiefen, Abstandsringe, Namen; kleine oder liegende Schiffe ausblenden.</li>
    <li><b>Tag / Dämmerung / Nacht / Auto</b> – Nacht ist dunkelrot und schont die Nachtsicht. Auto richtet sich nach dem Sonnenstand.</li>
    <li><b>Messen</b> – Punkte antippen: Strecke und Peilung. Nochmal tippen beendet.</li>
    <li><b>MOB</b> – markiert sofort die aktuelle Position (Mann über Bord). Unten links stehen dann Abstand, Peilung und Zeit. Nochmal tippen löscht die Markierung.</li></ul>
    <p>Ein <b>Tipp auf die Karte</b> zeichnet eine Peillinie von dir dorthin und zeigt Abstand, Peilung und Seitenpeilung (z. B. „Stb 35°“).</p>
    <h3>Kollisionswarnung</h3>
    <p><b>CPA</b> = Wie nah kommt mir das Schiff? <b>TCPA</b> = In wie vielen Minuten? Beim angetippten Schiff zeigen violette Linien, wo ihr beide im engsten Moment steht. Unter <b>Setup</b> wählst du das Fahrtgebiet: See (0,5 sm / 15 min), Revier (0,2 sm / 10 min) oder Kanal (~55 m / 4 min). Notfall-Sender (AIS-SART, MOB-Sender, EPIRB) lösen immer eine Warnung aus.</p>
    <h3>Gezeiten und Tiefenpunkte</h3>
    <p>Die kleinen <b>Punkte mit Zahlen</b> im Wasser zeigen die <b>Wassertiefe jetzt</b>: Kartentiefe (bezogen auf Seekartennull) plus der aktuelle Wasserstand am nächsten Pegel.
    Der Wasserstand kommt live vom Pegel (inklusive Windstau); fehlt eine Messung, nimmt die Karte die amtliche Gezeitenvorausberechnung des BSH.
    <b>Rot</b> = zu flach, <b>orange</b> = knapp, <b>blau</b> = ausreichend – nach deinem Tiefgang, den du unter <b>Gezeiten</b> einträgst.</p>
    <p>Oben in der Leiste steht die <b>Tide</b>: Höhe über Seekartennull, Pfeil steigend/fallend und das nächste Hoch- oder Niedrigwasser. Antippen öffnet Tidenkurve und Tidenkalender. Im Nord-Ostsee-Kanal steht dort der Kanalpegel.</p>
    <p class="note">Die Kartentiefen sind ein Raster von etwa 115 m – gebaggerte Fahrrinnen und Sände können abweichen. Amtliche Seekarte und Echolot gehen vor.</p>
    <h3>Wenn das AIS kurz weg ist</h3>
    <p>Bricht die Internetverbindung ab, bleiben alle Schiffe auf ihren letzten Positionen stehen (oben steht dann „AIS unterbrochen · … gehalten“). Sie werden mit der Zeit blasser. Sobald die Verbindung zurück ist, kommen sofort alle aktuellen Positionen – du musst nichts tun.</p>
    <h3>Gut zu wissen</h3>
    <ul><li>Ohne Internet keine neuen Schiffsdaten – Karte und zuletzt gesehene Schiffe bleiben sichtbar.</li>
    <li><b>iPad:</b> Damit der Bildschirm nicht ausgeht: Einstellungen → Anzeige &amp; Helligkeit → Automatische Sperre → Nie. Die Warnung piept nur bei offener Seekarte.</li>
    <li>Einen Einrichtungs-Link (MMSI) bitte in Safari öffnen <b>bevor</b> du die Seekarte zum Home-Bildschirm hinzufügst – die App hat sonst eigene Einstellungen.</li>
    <li>Am linken und unteren Rand läuft wie auf der Papierkarte die Minuten-Skala: 1 Minute Breite (links) = 1 Seemeile.</li></ul>
    <div class="warn">Hilfsmittel – kein zugelassenes Navigationsgerät (kein ECDIS). Immer Ausguck halten, Radar und amtliche Karte nutzen.</div>
    <p class="note">Daten: © OpenStreetMap-Mitwirkende (ODbL) über OpenFreeMap · Seezeichen © OpenSeaMap (CC BY-SA) · Tiefen © EMODnet Bathymetry (CC BY 4.0) · Satellit: Esri, Maxar, Earthstar Geographics · AIS: aisstream.io · Gezeiten: BSH-Gezeitenvorausberechnung, Wasserstände: WSV/PEGELONLINE · Kanal-km: OSM-Kilometersteine. Version ${VERSION}.</p>
    </div>`);
  $('#mBody [data-x]').onclick = closeModal;
}
$('#tHelp').onclick = help;

/* ================= Tag / Nacht ================= */
const THEMES = ['day', 'dusk', 'night', 'auto'], THEME_TXT = { day: 'Tag', dusk: 'Dämmerung', night: 'Nacht', auto: 'Auto' };
function sunAlt(lat, lon, date) {
  const d = date / 86400000 - 10957.5, g = rad(357.529 + 0.98560028 * d), q = 280.459 + 0.98564736 * d;
  const Lm = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)), e = rad(23.439 - 3.6e-7 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(Lm), Math.cos(Lm)), dec = Math.asin(Math.sin(e) * Math.sin(Lm));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24) * 15, ha = rad(gmst + lon) - ra;
  return deg(Math.asin(Math.sin(rad(lat)) * Math.sin(dec) + Math.cos(rad(lat)) * Math.cos(dec) * Math.cos(ha)));
}
function resolveTheme() {
  if (S.theme !== 'auto') return S.theme;
  const p = own || lastOwn || { lat: map.getCenter().lat, lon: map.getCenter().lng }, a = sunAlt(p.lat, p.lon, Date.now());
  return a > 0 ? 'day' : a > -6 ? 'dusk' : 'night';
}
function applyTheme() {
  const t = resolveTheme(), changed = t !== theme; theme = t;
  document.documentElement.dataset.theme = t;
  $('#themeLbl').textContent = THEME_TXT[S.theme];
  document.querySelector('meta[name=theme-color]').content = { day: '#0f2130', dusk: '#081016', night: '#000000' }[t];
  if (overlayReady && (changed || !iconsReady)) { applyPalette(); render(); }
  if (drawer === 'layers') renderLayers();
}
$('#tTheme').onclick = () => { S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]; save(); applyTheme(); toast(`Darstellung: ${THEME_TXT[S.theme]}`); };

/* ================= Bedienung ================= */
function setFollow(on) { follow = on; $('#tFollow').classList.toggle('on', on); }
$('#tFollow').onclick = () => {
  setFollow(!follow);
  const p = own || lastOwn;
  if (follow && p) map.easeTo({ center: ll(p), zoom: Math.max(map.getZoom(), 12.5), duration: 700 });
  else if (follow) toast('Noch keine eigene Position');
};
map.on('dragstart', () => { if (follow) setFollow(false); });
function syncOrient() {
  $('#orientLbl').textContent = S.orient === 'course' ? 'Kurs oben' : 'Nord oben';
  $('#tOrient').classList.toggle('on', S.orient === 'course');
  $('#orientIco').style.transform = `rotate(${-map.getBearing()}deg)`;
}
$('#tOrient').onclick = () => { S.orient = S.orient === 'north' ? 'course' : 'north'; save(); if (S.orient === 'north') map.easeTo({ bearing: 0, duration: 500 }); syncOrient(); toast(S.orient === 'course' ? 'Kurs oben: Karte dreht in Fahrtrichtung' : 'Nord oben'); };
$('#zIn').onclick = () => map.zoomIn({ duration: 250 });
$('#zOut').onclick = () => map.zoomOut({ duration: 250 });
let userTouchAt = 0;
map.on('touchstart', () => { userTouchAt = Date.now(); });
map.on('zoomstart', (e) => { if (e.originalEvent) userTouchAt = Date.now(); });
map.on('wheel', () => { userTouchAt = Date.now(); });
function steerMap() {
  if (Date.now() - userTouchAt < 1800 || map.isZooming()) return;
  const p = own;
  let bearing = map.getBearing();
  if (S.orient === 'course' && p) { const dir = p.hdg ?? (p.sog > 1 ? p.cog : null); if (dir != null) bearing = dir; }
  else if (S.orient === 'north') bearing = 0;
  const db = ((bearing - map.getBearing() + 540) % 360) - 180;
  if (follow && p) {
    const c = map.project(ll(p)), cc = map.project(map.getCenter());
    if (Math.hypot(c.x - cc.x, c.y - cc.y) > 2 || Math.abs(db) > 1) map.easeTo({ center: ll(p), bearing, duration: 950, easing: (x) => x });
  } else if (Math.abs(db) > 1) map.easeTo({ bearing, duration: 800 });
}

/* Messen & Antippen */
$('#tMeasure').onclick = () => {
  measuring = !measuring; $('#tMeasure').classList.toggle('on', measuring); measurePts = []; drawMeasure();
  if (measuring) probe('<b>Messen</b><div class="row2">Tippe Punkte auf der Karte an.</div>', true); else $('#probe').hidden = true;
};
function drawMeasure() {
  const f = [];
  if (measurePts.length > 1) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: measurePts.map(ll) }, properties: {} });
  let tot = 0;
  measurePts.forEach((q, i) => { if (i) tot += distM(measurePts[i - 1], q); f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ll(q) }, properties: i ? { t: nmTxt(tot) } : {} }); });
  if (overlayReady) map.getSource('meas').setData(FC(f));
  return tot;
}
let probeTimer = null;
function probe(html, sticky) { const el = $('#probe'); el.innerHTML = html; el.hidden = false; clearTimeout(probeTimer); if (!sticky) probeTimer = setTimeout(() => { el.hidden = true; probePt = null; render(); }, 12000); }
map.on('click', (e) => {
  const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  if (measuring) {
    measurePts.push(p); const tot = drawMeasure(), n = measurePts.length;
    probe(n < 2 ? '<b>Messen</b><div class="row2">Nächsten Punkt antippen …</div>' : `<b>${nmTxt(tot)}</b> <span class="note">(${de(tot / 1000, 2)} km)</span><div class="row2">Letzte Strecke: ${nmTxt(distM(measurePts[n - 2], measurePts[n - 1]))} auf ${p3(brg(measurePts[n - 2], measurePts[n - 1]))}°</div>`, true);
    return;
  }
  const r = 22, hits = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['tgt', 'hull', 'own'] });
  let best = null, bd = 1e9;
  for (const h of hits) {
    if (h.layer.id === 'own') { if (S.mmsi && ships.get(+S.mmsi)) { best = +S.mmsi; break; } continue; }
    const t = h.properties.m ? ships.get(+h.properties.m) : null; if (!t || !t.p) continue;
    const q = map.project(ll(t.p)), d = Math.hypot(q.x - e.point.x, q.y - e.point.y); if (d < bd) { bd = d; best = t.m; }
  }
  if (best != null) { select(best); return; }
  if (drawer === 'ship') { closeDrawer(); render(); return; }
  const o = own || lastOwn;
  probePt = o ? p : null; render();
  probe(`<b>${dm(p.lat, true)}  ${dm(p.lon, false)}</b>${o ? `<div class="row2"><b>${nmTxt(distM(o, p))}</b> · Peilung <b>${p3(brg(o, p))}°</b>${own ? ' · ' + relSide(own, brg(o, p)) : ''}</div>` : ''}${nokKm(p) != null ? `<div class="row2">NOK-km ${de(nokKm(p), 1)}</div>` : ''}`);
});
map.on('move', () => { drawEdge(); syncOrient(); });
map.on('moveend', () => { maybeSub(false); renderSoundings(); loadTides(); const c = map.getCenter(); store('sk_view', { lat: c.lat, lon: c.lng, z: map.getZoom() }); render(); });
addEventListener('resize', drawEdge);

/* ================= Wachhalten + Updates ================= */
let wakeLock = null, wakePending = false;
async function wake() {
  if (!S.wake) { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } return; }
  if (wakeLock || wakePending || document.hidden || !navigator.wakeLock) return;
  wakePending = true;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (_) {} finally { wakePending = false; }
}
navigator.storage?.persist?.().catch(() => {}); // Einstellungen/MMSI nicht vom System wegräumen lassen
if ('serviceWorker' in navigator) {
  const hadCtrl = !!navigator.serviceWorker.controller; // beim allerersten Besuch nicht neu laden (Assistent bliebe sonst hängen)
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast('Neue Version verfügbar – tippen zum Aktualisieren', () => { w.postMessage('skip'); });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
    setInterval(() => reg.update().catch(() => {}), 30 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadCtrl && !reloaded) { reloaded = true; location.reload(); } });
}

/* ================= Start ================= */
let tickN = 0;
function tick() {
  if (document.hidden) return;
  if (pendingShip && ships.get(pendingShip)?.la != null) { const t = ships.get(pendingShip); pendingShip = null; setFollow(false); select(t.m); map.jumpTo({ center: [t.lo, t.la], zoom: 14 }); }
  fuse(); render(); renderStrip(); renderAlert(); renderNear(); steerMap();
  if (drawer && Date.now() - drawerTouch > 1500 && !(document.activeElement && /INPUT/.test(document.activeElement.tagName) && dBody.contains(document.activeElement))) {
    if (drawer === 'list' || drawer === 'settings' || drawer === 'ship' || (drawer === 'tide' && tickN % 10 === 0)) renderDrawer(false);
  }
  if (++tickN % 60 === 0 && S.theme === 'auto') applyTheme();
  if (tickN % 5 === 0) maybeSub(false);
  if (tickN % 60 === 0) renderSoundings();
  if (dgPulse) map.setPaintProperty('dg-ring', 'circle-stroke-opacity', tickN % 2 ? .25 : 1);
}
let dgPulse = false;
map.on('load', () => {
  addOverlay(); overlayReady = true; theme = resolveTheme(); document.documentElement.dataset.theme = theme;
  applyPalette(); applyLayers(); syncOrient(); setFollow(true);
  dgPulse = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (S.demo) startDemo(); else connect();
  tick(); setInterval(tick, 1000);
  setTimeout(() => { fuse(); if (own && follow) map.jumpTo({ center: ll(own), zoom: Math.max(map.getZoom(), 12.5) }); }, 2500);
});
map.on('error', (e) => { if (e && e.error && /Failed to fetch|NetworkError/.test(String(e.error.message))) return; console.warn('Karte:', e && e.error && e.error.message); });
startGps(); applyTheme();
if (!S.onboarded) onboarding(0);
