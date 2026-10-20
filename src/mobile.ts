import * as THREE from 'three';
import ThreeGlobe from 'three-globe';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as satellite from 'satellite.js';
import { createIndex } from './satIndex';
import './style.css';

const EARTH_RADIUS_KM = 6371;
const EARTH_IMG = '/earth.jpg';
const PICK_RADIUS_PX = 22;
const MAX_ORBITS = 12; // most orbit rings drawn at once

interface Sat {
  name: string;
  satrec: satellite.SatRec;
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
let primary: Sat | null = null; // last selected
let multiMode = false;
let mlResults: Record<string, MlResult> = {};
let lastRing = 0;
let sortedIdx: number[] = [];
const collator = new Intl.Collator(undefined, { numeric: true });

// ---------- three.js scene ----------
const container = document.getElementById('cesiumContainer') as HTMLElement;
container.innerHTML = '';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.display = 'block';
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(new THREE.AmbientLight(0xcccccc, Math.PI));
scene.add(new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI));

const globe = new ThreeGlobe({ animateIn: false }).globeImageUrl(EARTH_IMG);
scene.add(globe);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 5000);
camera.position.z = 400;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 115;
controls.maxDistance = 1500;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.7;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- satellite point cloud (one object for all satellites) ----------
let positions = new Float32Array(0);
let colors = new Float32Array(0);
let cloudGeom = new THREE.BufferGeometry();

// highlight dots for the selected satellites
let selPositions = new Float32Array(3);
const selPoint = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, color: 0xffffff })
);
selPoint.frustumCulled = false;
selPoint.visible = false;
scene.add(selPoint);

function rebuildSelGeometry() {
  const n = selectedSet.size;
  selPositions = new Float32Array(Math.max(1, n) * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(selPositions, 3));
  const old = selPoint.geometry;
  selPoint.geometry = g;
  old.dispose();
  selPoint.visible = n > 0;
}

// orbit rings (white) and ground tracks (orange) for selected satellites
const orbitGroup = new THREE.Group();
scene.add(orbitGroup);
const ringMat = new THREE.LineBasicMaterial({ color: 0xffffff });
const trackMat = new THREE.LineBasicMaterial({ color: 0xffa500 });

function buildCloud() {
  const n = sats.length;
  positions = new Float32Array(n * 3);
  colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const iss = sats[i].isIss;
    colors[i * 3] = iss ? 1 : 0;
    colors[i * 3 + 1] = iss ? 1 : 0.9;
    colors[i * 3 + 2] = iss ? 0 : 0.95;
  }
  cloudGeom = new THREE.BufferGeometry();
  cloudGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  cloudGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const cloud = new THREE.Points(
    cloudGeom,
    new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true })
  );
  cloud.frustumCulled = false;
  scene.add(cloud);
}

// ---------- UI ----------
const BOX =
  'background:rgba(6,14,28,.88);color:#e8f1ff;border:1px solid #1f6d93;' +
  'border-radius:12px;font:14px system-ui,sans-serif;box-sizing:border-box;';

const top = document.createElement('div');
top.style.cssText =
  'position:absolute;top:6px;left:6px;right:6px;z-index:10;display:flex;gap:6px;align-items:center;';
document.body.appendChild(top);

const searchInput = document.createElement('input');
searchInput.placeholder = 'Search satellites…';
searchInput.style.cssText = BOX + 'padding:8px 12px;flex:1;min-width:0;outline:0;font-size:14px;';
top.appendChild(searchInput);

function topButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.style.cssText = BOX + 'padding:8px 11px;cursor:pointer;font-size:16px;';
  top.appendChild(b);
  return b;
}
const indexBtn = topButton('☰', 'Satellite index (A–Z)');
const multiBtn = topButton('☐', 'Multi-select');
const mlBtn = topButton('🧠', 'ML-tested satellites');

// dropdown list of ML-tested satellites
const chips = document.createElement('div');
chips.style.cssText =
  BOX +
  'position:absolute;top:50px;right:6px;z-index:11;padding:6px;display:none;' +
  'flex-direction:column;gap:6px;max-height:50vh;overflow:auto;';
document.body.appendChild(chips);
mlBtn.addEventListener('click', () => {
  chips.style.display = chips.style.display === 'none' ? 'flex' : 'none';
});

// small satellite count, bottom-left
const status = document.createElement('div');
status.style.cssText =
  'position:absolute;left:8px;bottom:8px;z-index:9;font:11px system-ui,sans-serif;' +
  'color:#9fb4d0;pointer-events:none;';
status.textContent = 'Loading satellites…';
document.body.appendChild(status);

// selected-satellite card (bottom)
const info = document.createElement('div');
info.style.cssText =
  BOX +
  'position:absolute;left:8px;right:8px;bottom:26px;z-index:10;padding:10px 12px;' +
  'max-height:42vh;overflow:auto;display:none;';
document.body.appendChild(info);

const infoHead = document.createElement('div');
infoHead.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';
const infoTitle = document.createElement('b');
const clearBtn = document.createElement('button');
clearBtn.textContent = 'Clear';
clearBtn.style.cssText = BOX + 'padding:4px 10px;cursor:pointer;';
clearBtn.addEventListener('click', () => setSelection([], false));
infoHead.append(infoTitle, clearBtn);
const infoBody = document.createElement('div');
info.append(infoHead, infoBody);

// index overlay
const indexPanel = document.createElement('div');
indexPanel.style.cssText =
  BOX +
  'position:absolute;left:6px;right:6px;top:50px;bottom:6px;z-index:12;padding:8px;' +
  'display:none;flex-direction:column;gap:6px;';
document.body.appendChild(indexPanel);

const indexHead = document.createElement('div');
indexHead.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
const indexTitle = document.createElement('b');
indexTitle.textContent = 'Satellite index';
const indexClose = document.createElement('button');
indexClose.textContent = '✕';
indexClose.style.cssText = BOX + 'padding:4px 10px;cursor:pointer;';
indexHead.append(indexTitle, indexClose);

const idx = createIndex({
  height: 'auto',
  onPick: (ref) => {
    const s = sats[ref];
    if (multiMode) {
      toggleInSelection(s, true);
    } else {
      setSelection([s], true);
      closeIndex();
    }
  },
  isSelected: (ref) => selectedSet.has(sats[ref]),
});
idx.element.style.flex = '1';
indexPanel.append(indexHead, idx.element);

function openIndex() {
  indexPanel.style.display = 'flex';
  idx.refresh();
}
function closeIndex() {
  indexPanel.style.display = 'none';
}
indexBtn.addEventListener('click', () =>
  indexPanel.style.display === 'none' ? openIndex() : closeIndex()
);
indexClose.addEventListener('click', closeIndex);

multiBtn.addEventListener('click', () => {
  multiMode = !multiMode;
  multiBtn.textContent = multiMode ? '☑' : '☐';
  multiBtn.style.borderColor = multiMode ? '#19c3f0' : '#1f6d93';
});

// ---------- ML bars ----------
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

function satBlock(s: Sat): string {
  const res = mlResults[String(s.satrec.satnum)];
  return (
    `<b>${s.name}</b><br>` +
    `NORAD ID: ${s.satrec.satnum}<br>` +
    `Altitude: ${s.altKm.toFixed(0)} km<br>` +
    `Speed: ${s.speedKms.toFixed(2)} km/s<br>` +
    `Lat: ${s.lat.toFixed(2)}°  Lon: ${s.lon.toFixed(2)}°<br>` +
    `Inclination: ${((s.satrec.inclo * 180) / Math.PI).toFixed(1)}°` +
    (res
      ? renderMl(res)
      : '<div style="font-size:11px;opacity:.7;margin-top:6px">No ML correction trained for this satellite.</div>')
  );
}

function updateInfo() {
  if (selectedSet.size === 0) {
    info.style.display = 'none';
    return;
  }
  info.style.display = 'block';
  const list = Array.from(selectedSet);
  const MAX_SHOW = 8;
  infoTitle.textContent = `Selected (${list.length})`;
  let html = list
    .slice(0, MAX_SHOW)
    .map(satBlock)
    .join('<hr style="border-color:#555">');
  if (list.length > MAX_SHOW) {
    html += `<div style="opacity:.7;margin-top:6px">+ ${list.length - MAX_SHOW} more selected (not listed)</div>`;
  }
  const st = info.scrollTop;
  infoBody.innerHTML = html;
  info.scrollTop = st;
}

function buildChips() {
  chips.innerHTML = '';
  for (const key of Object.keys(mlResults)) {
    const s = sats.find((x) => String(x.satrec.satnum) === key);
    if (!s) continue;
    const b = document.createElement('button');
    b.textContent = s.name;
    b.style.cssText = BOX + 'padding:8px 10px;white-space:nowrap;cursor:pointer;text-align:left;';
    b.addEventListener('click', () => {
      chips.style.display = 'none';
      searchInput.value = '';
      applyFilter();
      if (multiMode) toggleInSelection(s, true);
      else setSelection([s], true);
    });
    chips.appendChild(b);
  }
}

// ---------- data ----------
fetch('/ml_results.json')
  .then((r) => r.json())
  .then((j) => {
    mlResults = j;
    buildChips();
    updateInfo();
  })
  .catch(() => {});

const CATALOG_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
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
      /* skip */
    }
    return text;
  } catch (err) {
    if (stale) return stale;
    throw err;
  }
}

function parseSatellites(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    sats.push({
      name,
      satrec: satellite.twoline2satrec(l1, l2),
      isIss: name.startsWith('ISS (ZARYA)'),
      matches: true,
      ok: false,
      lat: 0,
      lon: 0,
      altKm: 0,
      speedKms: 0,
    });
  }
}

// ---------- index entries ----------
function refreshIndexEntries() {
  idx.setEntries(
    sortedIdx
      .filter((i) => sats[i].matches)
      .map((i) => ({ ref: i, name: sats[i].name, norad: String(sats[i].satrec.satnum) }))
  );
}

// ---------- positions ----------
function update() {
  const now = new Date();
  const gmst = satellite.gstime(now);
  let shown = 0;

  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    const pv = satellite.propagate(s.satrec, now);
    if (!pv || !pv.position) {
      s.ok = false;
      positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 0;
      continue;
    }
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    s.lat = satellite.degreesLat(gd.latitude);
    s.lon = satellite.degreesLong(gd.longitude);
    s.altKm = gd.height;
    s.ok = true;
    if (pv.velocity && selectedSet.has(s)) {
      s.speedKms = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    }
    if (!s.matches) {
      positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 0; // hidden inside the globe
      continue;
    }
    const c = globe.getCoords(s.lat, s.lon, s.altKm / EARTH_RADIUS_KM);
    positions[i * 3] = c.x;
    positions[i * 3 + 1] = c.y;
    positions[i * 3 + 2] = c.z;
    shown++;
  }
  cloudGeom.attributes.position.needsUpdate = true;
  status.textContent = `${shown} satellites shown`;

  // selected highlights
  let k = 0;
  for (const s of selectedSet) {
    if (s.ok) {
      const c = globe.getCoords(s.lat, s.lon, s.altKm / EARTH_RADIUS_KM);
      selPositions[k * 3] = c.x;
      selPositions[k * 3 + 1] = c.y;
      selPositions[k * 3 + 2] = c.z;
    } else {
      selPositions[k * 3] = selPositions[k * 3 + 1] = selPositions[k * 3 + 2] = 0;
    }
    k++;
  }
  (selPoint.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  if (selectedSet.size > 0 && Date.now() - lastRing > 10000) buildOrbitLines();
  updateInfo();
}

// ---------- orbit rings + ground tracks ----------
function periodMinutes(s: Sat): number {
  const rec: any = s.satrec;
  const no: number | undefined = rec.no_kozai ?? rec.no; // rad/min
  return no ? (2 * Math.PI) / no : 100;
}

function buildOrbitLines() {
  lastRing = Date.now();
  for (const c of Array.from(orbitGroup.children)) {
    orbitGroup.remove(c);
    (c as THREE.Line).geometry.dispose();
  }
  let count = 0;
  for (const s of selectedSet) {
    if (count++ >= MAX_ORBITS) break;
    const period = periodMinutes(s);
    const steps = 180;
    const now = new Date();
    const gmstNow = satellite.gstime(now);
    const ring: THREE.Vector3[] = [];
    const track: THREE.Vector3[] = [];

    for (let k = 0; k <= steps; k++) {
      const t = new Date(now.getTime() + (k / steps) * period * 60000);
      const pv = satellite.propagate(s.satrec, t);
      if (!pv || !pv.position) continue;
      const gr = satellite.eciToGeodetic(pv.position, gmstNow);
      const cr = globe.getCoords(
        satellite.degreesLat(gr.latitude),
        satellite.degreesLong(gr.longitude),
        gr.height / EARTH_RADIUS_KM
      );
      ring.push(new THREE.Vector3(cr.x, cr.y, cr.z));
      const gt = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
      const ct = globe.getCoords(
        satellite.degreesLat(gt.latitude),
        satellite.degreesLong(gt.longitude),
        0.003
      );
      track.push(new THREE.Vector3(ct.x, ct.y, ct.z));
    }
    if (ring.length > 1) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), ringMat);
      l.frustumCulled = false;
      orbitGroup.add(l);
    }
    if (track.length > 1) {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(track), trackMat);
      l.frustumCulled = false;
      orbitGroup.add(l);
    }
  }
}

// ---------- selection ----------
function focusOn(s: Sat) {
  if (!s.ok) return;
  const c = globe.getCoords(s.lat, s.lon, s.altKm / EARTH_RADIUS_KM);
  const dir = new THREE.Vector3(c.x, c.y, c.z).normalize();
  camera.position.copy(dir.multiplyScalar(Math.max(camera.position.length(), 220)));
  controls.update();
}

function selectionChanged(focus: boolean) {
  rebuildSelGeometry();
  buildOrbitLines();
  update();
  idx.refresh();
  if (focus && primary) focusOn(primary);
}

function setSelection(list: Sat[], focus: boolean) {
  selectedSet.clear();
  for (const s of list) selectedSet.add(s);
  primary = list.length ? list[list.length - 1] : null;
  selectionChanged(focus);
}

function toggleInSelection(s: Sat, focus: boolean) {
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
  selectionChanged(focus);
}

// ---------- search ----------
function applyFilter() {
  const q = searchInput.value.trim().toUpperCase();
  for (const s of sats) {
    s.matches = q === '' || s.name.toUpperCase().includes(q) || String(s.satrec.satnum) === q;
  }
  update();
  refreshIndexEntries();
}
searchInput.addEventListener('input', applyFilter);

// ---------- tap to pick (nearest satellite on screen, not hidden behind Earth) ----------
const tmp = new THREE.Vector3();

function occluded(i: number): boolean {
  const target = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  const dir = target.clone().sub(camera.position);
  const dist = dir.length();
  dir.normalize();
  const ray = new THREE.Ray(camera.position.clone(), dir);
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), globe.getGlobeRadius());
  const hit = ray.intersectSphere(sphere, new THREE.Vector3());
  return !!hit && camera.position.distanceTo(hit) < dist - 0.5;
}

function pickAt(px: number, py: number): number {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  const cand: { i: number; d: number }[] = [];
  for (let i = 0; i < sats.length; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x === 0 && y === 0 && z === 0) continue;
    tmp.set(x, y, z).project(camera);
    if (tmp.z > 1 || tmp.z < -1) continue;
    const d = Math.hypot((tmp.x * 0.5 + 0.5) * w - px, (-tmp.y * 0.5 + 0.5) * h - py);
    if (d < PICK_RADIUS_PX) cand.push({ i, d });
  }
  cand.sort((a, b) => a.d - b.d);
  for (const c of cand.slice(0, 8)) {
    if (!occluded(c.i)) return c.i;
  }
  return -1;
}

let downX = 0;
let downY = 0;
let downT = 0;
renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
  downX = e.clientX;
  downY = e.clientY;
  downT = performance.now();
});
renderer.domElement.addEventListener('pointerup', (e: PointerEvent) => {
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved < 8 && performance.now() - downT < 500) {
    const rect = renderer.domElement.getBoundingClientRect();
    const i = pickAt(e.clientX - rect.left, e.clientY - rect.top);
    chips.style.display = 'none';
    if (i >= 0) {
      if (multiMode) toggleInSelection(sats[i], false);
      else setSelection([sats[i]], false);
    } else if (!multiMode) {
      setSelection([], false);
    }
  }
});

// ---------- start ----------
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

async function main() {
  try {
    parseSatellites(await loadTleText());
    sortedIdx = sats.map((_, i) => i).sort((a, b) => collator.compare(sats[a].name, sats[b].name));
    buildCloud();
    buildChips();
    searchInput.placeholder = `Search ${sats.length} satellites`;
    refreshIndexEntries();
    update();
    setInterval(update, 1000);
  } catch (err) {
    console.error(err);
    status.textContent = 'Failed to load satellite data (see console)';
  }
}
main();