import {
  Viewer,
  Ion,
  Cartesian3,
  Color,
  Material,
  PointPrimitiveCollection,
  PointPrimitive,
  PolylineCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
} from 'cesium';
import * as satellite from 'satellite.js';
import './style.css';

const token = import.meta.env.VITE_CESIUM_TOKEN;
if (token) Ion.defaultAccessToken = token;

const viewer = new Viewer('cesiumContainer', {
  infoBox: false,
  selectionIndicator: false,
});

// ---------- types and state ----------
interface Sat {
  name: string;
  satrec: satellite.SatRec;
  point: PointPrimitive;
  isIss: boolean;
  matches: boolean;
  ok: boolean;
  lat: number;
  lon: number;
  altKm: number;
  speedKms: number;
}

interface MlResult {
  buckets: string[];
  sgp4: number[];
  hybrid: number[];
}

const sats: Sat[] = [];
const selectedSet = new Set<Sat>();
let primary: Sat | null = null; // last clicked; used for pass prediction
let multiMode = false;
let orbitMode: 'selected' | 'matching' = 'selected';
let bulkNote = '';
let shownCount = 0;
let lastOrbitBuild = 0;
let mlResults: Record<string, MlResult> = {};

const MAX_BULK = 300; // max satellites in "all matching" orbit mode
const BULK_STEPS = 90; // points per ring in bulk mode
const SEL_STEPS = 180; // points per ring for selected satellites

const points = viewer.scene.primitives.add(new PointPrimitiveCollection());
const ringLines = viewer.scene.primitives.add(new PolylineCollection());
const trackLines = viewer.scene.primitives.add(new PolylineCollection());

// ---------- UI ----------
const BOX =
  'padding:10px 14px;background:rgba(6,14,28,.88);color:#e8f1ff;' +
  'font:14px "Inter","Segoe UI",system-ui,sans-serif;border-radius:12px;' +
  'border:1px solid rgba(38,110,150,.75);box-shadow:0 8px 30px rgba(0,0,0,.45);';

// Styles for the control panel (UI only)
const uiStyle = document.createElement('style');
uiStyle.textContent = `
  .sp-panel{position:absolute;top:10px;left:10px;width:340px;min-width:250px;max-width:95vw;max-height:95vh;
    z-index:10;box-sizing:border-box;resize:both;overflow:auto;
    background:rgba(6,14,28,.9);color:#e8f1ff;border:1.5px solid #1f6d93;border-radius:16px;
    padding:14px;font-family:"Inter","Segoe UI",system-ui,sans-serif;
    box-shadow:0 10px 40px rgba(0,0,0,.55);backdrop-filter:blur(6px);}
  .sp-panel.collapsed{resize:none;width:auto!important;height:auto!important;min-width:0;}
  .sp-head{position:relative;padding-right:34px;padding-bottom:10px;border-bottom:2px solid #1291b8;}
  .sp-head .sp-hud{font-size:22px;font-weight:600;line-height:1.25;color:#f2f7ff;}
  .sp-head .sp-hud span{display:block;margin-top:4px;font-size:15px!important;font-weight:400;
    opacity:1!important;color:#a9b4e8;}
  .sp-toggle{position:absolute;top:0;right:0;width:28px;height:28px;border-radius:8px;
    border:1px solid #2b5f80;background:rgba(10,24,44,.9);color:#cfe4ff;cursor:pointer;
    display:flex;align-items:center;justify-content:center;padding:0;}
  .sp-toggle:hover{background:rgba(20,50,80,.95);}
  .sp-toggle svg{transition:transform .2s;}
  .sp-panel.collapsed .sp-toggle svg{transform:rotate(180deg);}
  .sp-panel.collapsed .sp-head{border-bottom:0;padding-bottom:0;}
  .sp-body{display:flex;flex-direction:column;gap:10px;margin-top:14px;}
  .sp-panel.collapsed .sp-body{display:none;}
  .sp-controls{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .sp-btn{display:flex;align-items:center;gap:10px;padding:11px 14px;min-width:0;
    background:rgba(10,22,42,.95);color:#eaf2ff;border:1.5px solid #2b5578;border-radius:12px;
    font:500 15px "Inter","Segoe UI",system-ui,sans-serif;cursor:pointer;text-align:left;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:border-color .15s,background .15s;}
  .sp-btn:hover{border-color:#3a8fc0;background:rgba(16,34,60,.95);}
  .sp-btn .sp-ico{flex:0 0 auto;display:inline-flex;}
  .sp-btn .sp-lbl{overflow:hidden;text-overflow:ellipsis;}
  .sp-btn.primary{border-color:#1a86ad;}
  .sp-btn.wide{grid-column:1 / -1;justify-content:space-between;}
  .sp-btn.wide .sp-lbl{flex:1;}
  .sp-search{display:flex;align-items:center;gap:10px;padding:0 14px;border:1.5px solid #2b5578;
    border-radius:12px;background:rgba(10,22,42,.95);}
  .sp-search:focus-within{border-color:#3a8fc0;}
  .sp-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#eaf2ff;
    font:15px "Inter","Segoe UI",system-ui,sans-serif;padding:12px 0;}
  .sp-search input::placeholder{color:#7e8fb5;}
  .sp-info{padding:10px 14px;background:rgba(10,22,42,.95);color:#e8f1ff;
    border:1.5px solid #2b5578;border-radius:12px;font:14px "Inter","Segoe UI",system-ui,sans-serif;
    display:none;max-height:45vh;overflow:auto;}
  .sp-panel::-webkit-scrollbar,.sp-info::-webkit-scrollbar{width:8px;}
  .sp-panel::-webkit-scrollbar-thumb,.sp-info::-webkit-scrollbar-thumb{background:#2b5578;border-radius:4px;}
`;
document.head.appendChild(uiStyle);

const ICONS = {
  pin:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="#19c3f0"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  box:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8f1ff" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  boxChecked:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/></svg>',
  x:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8f1ff" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  brain:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ff4fd8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/><path d="M9 9h1M14 9h1M9 14h1M14 14h1"/></svg>',
  chevron:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#cfe4ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  search:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8f1ff" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  collapse:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
};

const column = document.createElement('div');
column.className = 'sp-panel';
document.body.appendChild(column);

const header = document.createElement('div');
header.className = 'sp-head';
column.appendChild(header);

const hud = document.createElement('div');
hud.className = 'sp-hud';
hud.textContent = 'Loading satellites…';
header.appendChild(hud);

const toggleBtn = document.createElement('button');
toggleBtn.className = 'sp-toggle';
toggleBtn.title = 'Collapse / expand panel';
toggleBtn.innerHTML = ICONS.collapse;
toggleBtn.addEventListener('click', () => {
  const c = column.classList.toggle('collapsed');
  if (c) {
    column.dataset.w = column.style.width;
    column.dataset.h = column.style.height;
    column.style.width = '';
    column.style.height = '';
  } else {
    if (column.dataset.w) column.style.width = column.dataset.w;
    if (column.dataset.h) column.style.height = column.dataset.h;
  }
});
   if (window.innerWidth < 600) column.classList.add('collapsed');

header.appendChild(toggleBtn);

const body = document.createElement('div');
body.className = 'sp-body';
column.appendChild(body);

const controls = document.createElement('div');
controls.className = 'sp-controls';
body.appendChild(controls);

function setLabel(b: HTMLButtonElement, label: string, icon?: string) {
  const lbl = b.querySelector('.sp-lbl');
  if (lbl) lbl.textContent = label;
  if (icon !== undefined) {
    const ic = b.querySelector('.sp-ico');
    if (ic) ic.innerHTML = icon;
  }
}

function makeButton(
  label: string,
  onClick: () => void,
  icon = '',
  opts: { primary?: boolean; wide?: boolean; trailing?: string } = {}
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sp-btn' + (opts.primary ? ' primary' : '') + (opts.wide ? ' wide' : '');
  b.innerHTML =
    (icon ? '<span class="sp-ico">' + icon + '</span>' : '<span class="sp-ico"></span>') +
    '<span class="sp-lbl"></span>' +
    (opts.trailing ? '<span class="sp-ico">' + opts.trailing + '</span>' : '');
  setLabel(b, label);
  b.addEventListener('click', onClick);
  controls.appendChild(b);
  return b;
}

const locBtn = makeButton('Use my location', useMyLocation, ICONS.pin, { primary: true });
const multiBtn = makeButton('Multi-select', toggleMulti, ICONS.box);
const orbitBtn = makeButton('Orbits: selected only', toggleOrbitMode, '', {
  wide: true,
  trailing: ICONS.chevron,
});
makeButton('Clear selection', () => setSelection([]), ICONS.x);
makeButton('ML-tested', selectMlSats, ICONS.brain);

const searchWrap = document.createElement('div');
searchWrap.className = 'sp-search';
searchWrap.innerHTML = ICONS.search;
body.appendChild(searchWrap);

const search = document.createElement('input');
search.placeholder = 'Search name or NORAD ID';
searchWrap.appendChild(search);

const info = document.createElement('div');
info.className = 'sp-info';
body.appendChild(info);

const passesBox = document.createElement('div');
passesBox.style.cssText =
  'position:absolute;top:60px;right:10px;z-index:10;display:none;' +
  'max-height:60vh;overflow:auto;' + BOX;
document.body.appendChild(passesBox);

// ---------- ML results (precomputed in the notebook) ----------
fetch('/ml_results.json')
  .then((r) => r.json())
  .then((j) => {
    mlResults = j;
    updateInfo();
  })
  .catch(() => {
    /* no results file: panels just say "not trained" */
  });

function renderMl(res: MlResult): string {
  const max = Math.max(...res.sgp4);
  const last = res.buckets.length - 1;
  const pct = (res.hybrid[last] / res.sgp4[last] - 1) * 100;
  const rows = res.buckets
    .map((b, k) => {
      const w1 = (res.sgp4[k] / max) * 100;
      const w2 = (res.hybrid[k] / max) * 100;
      return (
        `<div style="margin-top:4px">${b} h` +
        `<div style="background:#f66;height:6px;width:${w1}%"></div>` +
        `<div style="background:#6f6;height:6px;width:${w2}%;margin-top:2px"></div></div>`
      );
    })
    .join('');
  return (
    `<div style="margin-top:8px"><b>Prediction error vs forecast time</b><br>` +
    `<span style="color:#f66">■ SGP4</span> <span style="color:#6f6">■ SGP4 + ML</span><br>` +
    `<span style="font-size:12px">Median error at ${res.buckets[last]} h: ${pct.toFixed(0)}%</span>` +
    rows +
    `<div style="font-size:11px;opacity:.7;margin-top:6px">Median km vs the next official TLE, tested on 2025 data.</div></div>`
  );
}

// ---------- data loading ----------
const CATALOG_URL =
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const CACHE_KEY = 'tle-active';
const CACHE_MS = 2 * 60 * 60 * 1000;

function looksLikeTle(t: string): boolean {
  return !t.trimStart().startsWith('<') && t.includes('\n1 ') && t.includes('\n2 ');
}

async function loadTleText(): Promise<string> {
  try {
    const local = await fetch('/active.tle');
    if (local.ok) {
      const t = await local.text();
      if (looksLikeTle(t)) return t;
    }
  } catch {
    /* fall through */
  }

  let stale: string | null = null;
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { time, text } = JSON.parse(cached);
      if (Date.now() - time < CACHE_MS) return text;
      stale = text;
    }
  } catch {
    /* ignore */
  }

  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error(`CelesTrak responded with ${res.status}`);
    const text = await res.text();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), text }));
    } catch {
      /* storage full: skip */
    }
    return text;
  } catch (err) {
    if (stale) return stale;
    throw err;
  }
}

function addSatellites(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;

    const satrec = satellite.twoline2satrec(l1, l2);
    const point = points.add({
      id: sats.length,
      position: Cartesian3.ZERO,
      pixelSize: 3,
      color: Color.CYAN.withAlpha(0.85),
      show: false,
    });
    const sat: Sat = {
      name,
      satrec,
      point,
      isIss: name.startsWith('ISS (ZARYA)'),
      matches: true,
      ok: false,
      lat: 0,
      lon: 0,
      altKm: 0,
      speedKms: 0,
    };
    sats.push(sat);
    styleSat(sat);
  }
}

// ---------- styling and selection ----------
function styleSat(s: Sat) {
  if (s === primary) {
    s.point.color = Color.WHITE;
    s.point.pixelSize = 12;
  } else if (selectedSet.has(s)) {
    s.point.color = Color.WHITE;
    s.point.pixelSize = 9;
  } else if (s.isIss) {
    s.point.color = Color.YELLOW;
    s.point.pixelSize = 10;
  } else {
    s.point.color = Color.CYAN.withAlpha(0.85);
    s.point.pixelSize = 3;
  }
}

function refreshAll() {
  update();
  rebuildOrbits();
  updatePasses();
}

function setSelection(list: Sat[]) {
  const before = Array.from(selectedSet);
  selectedSet.clear();
  for (const s of list) selectedSet.add(s);
  primary = list.length ? list[list.length - 1] : null;
  for (const s of new Set([...before, ...list])) styleSat(s);
  refreshAll();
}

function toggleInSelection(s: Sat) {
  const before = Array.from(selectedSet);
  if (selectedSet.has(s)) {
    selectedSet.delete(s);
    if (primary === s) {
      const rest = Array.from(selectedSet);
      primary = rest.length ? rest[rest.length - 1] : null;
    }
  } else {
    selectedSet.add(s);
    primary = s;
  }
  for (const x of new Set([...before, s])) styleSat(x);
  refreshAll();
}

function toggleMulti() {
  multiMode = !multiMode;
  setLabel(
    multiBtn,
    multiMode ? 'Multi-select (click adds/removes)' : 'Multi-select',
    multiMode ? ICONS.boxChecked : ICONS.box
  );
}

function toggleOrbitMode() {
  orbitMode = orbitMode === 'selected' ? 'matching' : 'selected';
  setLabel(
    orbitBtn,
    orbitMode === 'selected'
      ? 'Orbits: selected only'
      : `Orbits: all matching (max ${MAX_BULK})`
  );
  rebuildOrbits();
}

function selectMlSats() {
  const found = sats.filter((s) => mlResults[String(s.satrec.satnum)]);
  if (!found.length) {
    alert('None of the ML-tested satellites are in the loaded catalog.');
    return;
  }
  search.value = '';
  for (const s of sats) s.matches = true;
  setSelection(found);
}

// ---------- panels ----------
function updateHud() {
  hud.innerHTML =
    `${shownCount} shown · ${selectedSet.size} selected` +
    (bulkNote ? `<br><span style="font-size:12px;opacity:.85">${bulkNote}</span>` : '');
}

function satBlock(s: Sat): string {
  let h =
    `<b>${s.name}</b><br>` +
    `NORAD ID: ${s.satrec.satnum}<br>` +
    `Altitude: ${s.altKm.toFixed(0)} km<br>` +
    `Speed: ${s.speedKms.toFixed(2)} km/s<br>` +
    `Lat: ${s.lat.toFixed(2)}°  Lon: ${s.lon.toFixed(2)}°<br>` +
    `Inclination: ${((s.satrec.inclo * 180) / Math.PI).toFixed(1)}°`;
  const res = mlResults[String(s.satrec.satnum)];
  h += res
    ? renderMl(res)
    : '<div style="font-size:11px;opacity:.7;margin-top:6px">No ML correction trained for this satellite.</div>';
  return h;
}

function updateInfo() {
  if (selectedSet.size === 0) {
    info.style.display = 'none';
    return;
  }
  info.style.display = 'block';
  const list = Array.from(selectedSet);
  const MAX_SHOW = 12;
  let html = list
    .slice(0, MAX_SHOW)
    .map(satBlock)
    .join('<hr style="border-color:#555">');
  if (list.length > MAX_SHOW) {
    html += `<div style="opacity:.7;margin-top:6px">+ ${list.length - MAX_SHOW} more selected (not listed)</div>`;
  }
  const st = info.scrollTop;
  info.innerHTML = html;
  info.scrollTop = st;
}

// ---------- update loop ----------
function update() {
  const now = new Date();
  const gmst = satellite.gstime(now);
  let shown = 0;

  for (const s of sats) {
    const pv = satellite.propagate(s.satrec, now);
    if (!pv || !pv.position) {
      s.ok = false;
      s.point.show = false;
      continue;
    }
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    s.lon = satellite.degreesLong(gd.longitude);
    s.lat = satellite.degreesLat(gd.latitude);
    s.altKm = gd.height;
    s.point.position = Cartesian3.fromDegrees(s.lon, s.lat, gd.height * 1000);
    s.ok = true;
    s.point.show = s.matches;
    if (s.matches) shown++;

    if (selectedSet.has(s) && pv.velocity) {
      s.speedKms = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    }
  }
  shownCount = shown;
  updateHud();
  updateInfo();
  if (Date.now() - lastOrbitBuild > 10000) rebuildOrbits();
}

// ---------- orbit rings and ground tracks ----------
function periodMinutes(s: Sat): number {
  const rec: any = s.satrec;
  const no: number | undefined = rec.no_kozai ?? rec.no; // rad/min
  return no ? (2 * Math.PI) / no : 100;
}

function ringFor(s: Sat, steps: number): Cartesian3[] {
  const now = new Date();
  const gmstNow = satellite.gstime(now);
  const period = periodMinutes(s);
  const out: Cartesian3[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = new Date(now.getTime() + (k / steps) * period * 60000);
    const pv = satellite.propagate(s.satrec, t);
    if (!pv || !pv.position) continue;
    const g = satellite.eciToGeodetic(pv.position, gmstNow);
    out.push(
      Cartesian3.fromDegrees(
        satellite.degreesLong(g.longitude),
        satellite.degreesLat(g.latitude),
        g.height * 1000
      )
    );
  }
  return out;
}

function trackFor(s: Sat, steps: number): Cartesian3[] {
  const now = new Date();
  const period = periodMinutes(s);
  const out: Cartesian3[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = new Date(now.getTime() + (k / steps) * period * 60000);
    const pv = satellite.propagate(s.satrec, t);
    if (!pv || !pv.position) continue;
    const g = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    out.push(
      Cartesian3.fromDegrees(
        satellite.degreesLong(g.longitude),
        satellite.degreesLat(g.latitude),
        0
      )
    );
  }
  return out;
}

function rebuildOrbits() {
  ringLines.removeAll();
  trackLines.removeAll();
  lastOrbitBuild = Date.now();
  bulkNote = '';

  if (orbitMode === 'matching') {
    const bulk = sats.filter((s) => s.ok && s.matches && !selectedSet.has(s));
    if (bulk.length + selectedSet.size > MAX_BULK) {
      bulkNote = `${bulk.length} match. Orbits show only when ≤ ${MAX_BULK}: narrow the search.`;
    } else {
      for (const s of bulk) {
        const positions = ringFor(s, BULK_STEPS);
        if (positions.length < 2) continue;
        ringLines.add({
          positions,
          width: 1,
          material: Material.fromType('Color', { color: Color.CYAN.withAlpha(0.35) }),
        });
      }
    }
  }

  for (const s of selectedSet) {
    const ring = ringFor(s, SEL_STEPS);
    if (ring.length >= 2) {
      ringLines.add({
        positions: ring,
        width: 2,
        material: Material.fromType('Color', { color: Color.WHITE.withAlpha(0.85) }),
      });
    }
    const track = trackFor(s, SEL_STEPS);
    if (track.length >= 2) {
      trackLines.add({
        positions: track,
        width: 2,
        material: Material.fromType('Color', { color: Color.ORANGE.withAlpha(0.9) }),
      });
    }
  }
  updateHud();
}

// ---------- search ----------
search.addEventListener('input', () => {
  const q = search.value.trim().toUpperCase();
  for (const s of sats) {
    s.matches =
      q === '' || s.name.toUpperCase().includes(q) || String(s.satrec.satnum) === q;
  }
  update();
  rebuildOrbits();
});

// ---------- click ----------
const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((click: any) => {
  const picked = viewer.scene.pick(click.position);
  const hit: Sat | null =
    picked && typeof picked.id === 'number' ? sats[picked.id] ?? null : null;

  if (!hit) {
    if (!multiMode) setSelection([]); // in multi-select, empty clicks keep selection
    return;
  }
  if (multiMode) toggleInSelection(hit);
  else setSelection([hit]);
}, ScreenSpaceEventType.LEFT_CLICK);

// ---------- my location + pass prediction (for the last-selected satellite) ----------
let observer: { lat: number; lon: number } | null = null;
let observerMarker: any = null;

function useMyLocation() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported in this browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setObserver(pos.coords.latitude, pos.coords.longitude),
    () => alert('Could not get your location. Allow location access and try again.')
  );
}

function setObserver(lat: number, lon: number) {
  observer = { lat, lon };
  if (observerMarker) viewer.entities.remove(observerMarker);
  observerMarker = viewer.entities.add({
    position: Cartesian3.fromDegrees(lon, lat, 0),
    point: { pixelSize: 10, color: Color.LIME },
  });
  setLabel(locBtn, 'Location set');
  updatePasses();
}

interface Pass {
  start: Date;
  end: Date;
  maxEl: number;
}

function computePasses(s: Sat, hours = 24, stepSec = 30, minEl = 10): Pass[] {
  if (!observer) return [];
  const obsGd = {
    longitude: satellite.degreesToRadians(observer.lon),
    latitude: satellite.degreesToRadians(observer.lat),
    height: 0,
  };
  const result: Pass[] = [];
  const t0 = Date.now();
  let cur: Pass | null = null;

  for (let t = t0; t <= t0 + hours * 3600 * 1000; t += stepSec * 1000) {
    const d = new Date(t);
    const pv = satellite.propagate(s.satrec, d);
    let el = -90;
    if (pv && pv.position) {
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(d));
      const look = satellite.ecfToLookAngles(obsGd, ecf);
      el = (look.elevation * 180) / Math.PI;
    }
    if (el >= minEl) {
      if (!cur) cur = { start: d, end: d, maxEl: el };
      cur.end = d;
      if (el > cur.maxEl) cur.maxEl = el;
    } else if (cur) {
      result.push(cur);
      cur = null;
    }
  }
  if (cur) result.push(cur);
  return result;
}

function fmtTime(d: Date) {
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function updatePasses() {
  if (!primary) {
    passesBox.style.display = 'none';
    return;
  }
  passesBox.style.display = 'block';
  if (!observer) {
    passesBox.textContent = 'Click "Use my location" to see passes.';
    return;
  }
  const passes = computePasses(primary);
  passesBox.innerHTML =
    `<b>${primary.name}</b><br>Next 24 h over you (above 10°):<br>` +
    (passes.length
      ? passes
          .map((p) => `${fmtTime(p.start)} → ${fmtTime(p.end)} · peak ${p.maxEl.toFixed(0)}°`)
          .join('<br>')
      : 'No passes.');
}

// ---------- start ----------
async function main() {
  try {
    const text = await loadTleText();
    addSatellites(text);
    update();
    setInterval(update, 1000);
  } catch (err) {
    console.error(err);
    hud.textContent = 'Failed to load satellite data (see console)';
  }
}

main();