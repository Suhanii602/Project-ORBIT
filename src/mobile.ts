import * as THREE from 'three';
import ThreeGlobe from 'three-globe';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as satellite from 'satellite.js';
import './style.css';

const EARTH_RADIUS_KM = 6371;
const EARTH_IMG = '/earth.jpg';
const PICK_RADIUS_PX = 22;
const MAX_ORBITS = 12; // most orbit rings drawn at once
const ROW = 80; // list row height (px)

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
  elev: number; // elevation above the observer's horizon (deg), only when a location is set
  intl: string; // international designator from the TLE (e.g. 20006A)
}
interface MlResult {
  buckets: string[];
  sgp4: number[];
  hybrid: number[];
}
type Screen = 'home' | 'sats' | 'detail';
type OrbitFilter = 'ALL' | 'LEO' | 'MEO' | 'GEO';

const sats: Sat[] = [];
const selectedSet = new Set<Sat>();
let primary: Sat | null = null; // last selected
let primaryIdx = -1;
let multiMode = false;
let mlResults: Record<string, MlResult> = {};
let lastRing = 0;
let sortedIdx: number[] = [];
const collator = new Intl.Collator(undefined, { numeric: true });

// UI state
let screen: Screen = 'home';
let prevScreen: Screen = 'home';
let viewMode: '3d' | '2d' = '3d';
let sheetOpen = false;
let sheetTab: 'info' | 'orbit' = 'info';
let detailTab: 'overview' | 'orbit' | 'technical' = 'overview';
let orbitFilter: OrbitFilter = 'ALL';
let sortMode: 'name' | 'alt' | 'norad' = 'name';
let showLines = true;
let observer: { lat: number; lon: number } | null = null;
let panX = 0; // 2D map horizontal pan (px)
let visibleList: number[] = [];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function orbitClass(alt: number): string {
  if (alt < 2000) return 'LEO';
  if (alt < 35000) return 'MEO';
  if (alt <= 36500) return 'GEO';
  return 'HEO';
}

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

function applyViewOffset() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (sheetOpen && viewMode === '3d') camera.setViewOffset(W, H, 0, H * 0.22, W, H);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyViewOffset();
  sizeMap2d();
  draw2d();
  renderList(true);
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

// marker for the user's location
const obsMarker = new THREE.Mesh(
  new THREE.SphereGeometry(1.4, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0x7dff4f })
);
obsMarker.visible = false;
scene.add(obsMarker);

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

// ---------- 2D map (canvas) ----------
const map2d = document.createElement('canvas');
map2d.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;touch-action:none;';
container.appendChild(map2d);
const ctx2d = map2d.getContext('2d') as CanvasRenderingContext2D;
const earthImg = new Image();
earthImg.src = EARTH_IMG;
earthImg.onload = () => draw2d();

function sizeMap2d() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  map2d.width = Math.round(window.innerWidth * dpr);
  map2d.height = Math.round(window.innerHeight * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeMap2d();

function mapGeom() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const mh = Math.min(H * 0.5, W * 0.9);
  const sc = mh / 180;
  const cy = H * (sheetOpen ? 0.3 : 0.5);
  return { W, H, sc, mw: 360 * sc, top: cy - mh / 2 };
}
function xy2d(lat: number, lon: number, g: ReturnType<typeof mapGeom>): [number, number] {
  let x = ((lon + 180) * g.sc + panX) % g.mw;
  if (x < 0) x += g.mw;
  return [x, g.top + (90 - lat) * g.sc];
}

function trackLatLon(s: Sat): [number, number][] {
  const period = periodMinutes(s);
  const now = new Date();
  const out: [number, number][] = [];
  for (let k = 0; k <= 120; k++) {
    const t = new Date(now.getTime() + (k / 120) * period * 60000);
    const pv = satellite.propagate(s.satrec, t);
    if (!pv || !pv.position) continue;
    const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    out.push([satellite.degreesLat(gd.latitude), satellite.degreesLong(gd.longitude)]);
  }
  return out;
}

function draw2d() {
  if (viewMode !== '2d') return;
  const g = mapGeom();
  const c = ctx2d;
  c.fillStyle = '#02060f';
  c.fillRect(0, 0, g.W, g.H);
  if (earthImg.complete && earthImg.naturalWidth) {
    for (let x = ((panX % g.mw) + g.mw) % g.mw - g.mw; x < g.W; x += g.mw) {
      c.drawImage(earthImg, x, g.top, g.mw, g.sc * 180);
    }
  }
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    if (!s.ok || !s.matches) continue;
    const [x, y] = xy2d(s.lat, s.lon, g);
    c.fillStyle = s.isIss ? '#ffe600' : '#19e6f2';
    for (let xx = x; xx < g.W; xx += g.mw) c.fillRect(xx - 1, y - 1, 2.4, 2.4);
  }
  if (observer) {
    const [x, y] = xy2d(observer.lat, observer.lon, g);
    c.fillStyle = '#7dff4f';
    for (let xx = x; xx < g.W; xx += g.mw) {
      c.beginPath();
      c.arc(xx, y, 4, 0, Math.PI * 2);
      c.fill();
    }
  }
  let n = 0;
  for (const s of selectedSet) {
    if (n++ >= MAX_ORBITS) break;
    if (showLines) {
      const pts = trackLatLon(s);
      c.strokeStyle = '#ffa500';
      c.lineWidth = 1.5;
      for (const off of [-g.mw, 0, g.mw]) {
        c.beginPath();
        let prev = NaN;
        pts.forEach(([la, lo], k) => {
          let [x, y] = xy2d(la, lo, g);
          if (!Number.isNaN(prev)) x += g.mw * Math.round((prev - x) / g.mw);
          prev = x;
          if (k === 0) c.moveTo(x + off, y);
          else c.lineTo(x + off, y);
        });
        c.stroke();
      }
    }
    if (s.ok) {
      const [x, y] = xy2d(s.lat, s.lon, g);
      c.fillStyle = '#fff';
      for (let xx = x; xx < g.W; xx += g.mw) {
        c.beginPath();
        c.arc(xx, y, s === primary ? 5 : 4, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
  // label for the primary satellite
  if (primary && primary.ok && primary.matches && screen === 'home') {
    const [x, y] = xy2d(primary.lat, primary.lon, g);
    labelEl.style.display = 'flex';
    labelEl.style.transform = `translate(${x}px,${y}px)`;
  } else if (viewMode === '2d') {
    labelEl.style.display = 'none';
  }
}

// ---------- icons ----------
const ic = (d: string, size = 22, stroke = 'currentColor', fill = 'none') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const SAT_PATH =
  '<rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M5 5l3 3M16 16l3 3M3 9l6-6M15 21l6-6M7.5 7.5L4 11M13 20l3.5-3.5"/>';
const ICON = {
  logo:
    '<svg width="32" height="32" viewBox="0 0 48 48" fill="none" stroke="#e8f1ff" stroke-width="2" stroke-linecap="round"><ellipse cx="24" cy="24" rx="19" ry="8" transform="rotate(-35 24 24)"/><circle cx="24" cy="24" r="9"/><circle cx="38" cy="12" r="2.6" fill="#19c3f0" stroke="#19c3f0"/></svg>',
  menu: ic('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  sat: ic(SAT_PATH, 34, '#19c3f0'),
  satRing: ic(SAT_PATH, 26, '#bfe6ff'),
  locate: ic('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>', 22, '#cfe4ff'),
  layers: ic('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>', 22, '#cfe4ff'),
  globe: ic('<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>', 22, '#cfe4ff'),
  expand: ic('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 22, '#cfe4ff'),
  home: ic('<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>', 24),
  satNav: ic(SAT_PATH, 24),
  search: ic('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', 22),
  more: ic('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', 24),
  back: ic('<path d="M15 5l-7 7 7 7"/>', 22),
  x: ic('<path d="M5 5l14 14M19 5L5 19"/>', 20),
  chev: ic('<path d="M9 5l7 7-7 7"/>', 18, '#8ba3bd'),
  down: ic('<path d="M6 9l6 6 6-6"/>', 18, '#cfe4ff'),
  sliders: ic('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>', 22, '#cfe4ff'),
  alt: ic('<path d="M12 4l7 15H5z"/><path d="M12 10v4"/>', 24, '#bfe6ff'),
  speed: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 12l4-4M7 15h2"/>', 24, '#bfe6ff'),
  period: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>', 24, '#bfe6ff'),
  compass:
    '<svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="#6fd6f5" stroke-width="1"><circle cx="20" cy="20" r="17"/><circle cx="20" cy="20" r="9" opacity=".5"/><path d="M20 6v5M20 29v5M6 20h5M29 20h5" opacity=".6"/><path d="M20 11l4 11-4-2-4 2z" fill="#19c3f0" stroke="none"/></svg>',
};

function satArt(viewBox: string): string {
  return (
    `<svg viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">` +
    '<defs><linearGradient id="spn" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6be0"/><stop offset="1" stop-color="#0a2468"/></linearGradient>' +
    '<radialGradient id="ear" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#62c0ff"/><stop offset=".3" stop-color="#1d63b0"/><stop offset="1" stop-color="#06162e"/></radialGradient></defs>' +
    '<rect width="390" height="220" fill="#030a16"/>' +
    '<g fill="#cfe4ff" opacity=".7"><circle cx="30" cy="30" r="1"/><circle cx="90" cy="70" r="1.2"/><circle cx="330" cy="40" r="1"/><circle cx="360" cy="110" r="1.3"/><circle cx="60" cy="130" r="1"/><circle cx="250" cy="25" r="1"/><circle cx="150" cy="15" r="1.2"/></g>' +
    '<ellipse cx="195" cy="340" rx="340" ry="160" fill="url(#ear)"/>' +
    '<g transform="rotate(-28 195 100)">' +
    '<rect x="30" y="80" width="110" height="40" fill="url(#spn)" stroke="#8fb8ff" stroke-width=".8"/>' +
    '<rect x="250" y="80" width="110" height="40" fill="url(#spn)" stroke="#8fb8ff" stroke-width=".8"/>' +
    '<path d="M58 80v40M86 80v40M113 80v40M278 80v40M306 80v40M333 80v40M30 100h110M250 100h110" stroke="#8fb8ff" stroke-width=".6" opacity=".7"/>' +
    '<rect x="140" y="96" width="12" height="8" fill="#778"/><rect x="238" y="96" width="12" height="8" fill="#778"/>' +
    '<rect x="152" y="86" width="86" height="28" rx="3" fill="#c8b98a" stroke="#efe3bd" stroke-width=".8"/>' +
    '<circle cx="195" cy="100" r="7" fill="#556" stroke="#aab" stroke-width=".8"/></g></svg>'
  );
}

// ---------- UI ----------
const styleEl = document.createElement('style');
styleEl.textContent = `
.ob-root{position:fixed;inset:0;z-index:10;pointer-events:none;color:#e8f1ff;font-family:"Inter","Segoe UI",system-ui,sans-serif;-webkit-tap-highlight-color:transparent;}
.ob-root *{box-sizing:border-box;}
.ob-root button{font:inherit;color:inherit;cursor:pointer;}
.ob-home{position:absolute;inset:0;}
.ob-home.hide{visibility:hidden;}
.ob-top{position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);left:14px;right:14px;display:flex;flex-direction:column;gap:12px;pointer-events:auto;}
.ob-head{display:flex;align-items:center;gap:12px;}
.ob-logo{width:46px;height:46px;border:1px solid #1d4660;border-radius:12px;background:rgba(10,26,44,.9);display:flex;align-items:center;justify-content:center;}
.ob-ttl{flex:1;min-width:0;}
.ob-ttl .a{font-size:20px;letter-spacing:.3em;font-weight:500;}
.ob-ttl .b{font:9.5px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;color:#8ba3bd;margin-top:3px;white-space:nowrap;}
.ob-icon{width:44px;height:44px;border-radius:12px;border:1px solid #1d4660;background:rgba(10,24,42,.92);display:flex;align-items:center;justify-content:center;padding:0;pointer-events:auto;}
.ob-icon.on{border-color:#19c3f0;background:rgba(25,195,240,.16);}
.ob-card{background:rgba(8,20,36,.88);border:1px solid #1b4560;border-radius:16px;backdrop-filter:blur(8px);}
.ob-stats{display:flex;padding:12px 14px;}
.ob-st{flex:1;display:flex;align-items:center;gap:12px;min-width:0;}
.ob-st + .ob-st{border-left:1px solid #123247;padding-left:16px;}
.ob-l{font-size:12px;color:#8ba3bd;white-space:nowrap;}
.ob-v{font-size:22px;font-weight:500;line-height:1.2;}
.gd{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22d36b;box-shadow:0 0 6px #22d36b;margin-right:6px;}
.gd.off{background:#6b7683;box-shadow:none;}
.ob-side{position:absolute;top:calc(env(safe-area-inset-top,0px) + 170px);right:14px;display:flex;flex-direction:column;gap:10px;}
.ob-bottom{position:absolute;left:14px;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 84px);display:flex;flex-direction:column;gap:12px;}
.ob-coord{width:216px;padding:8px 12px;display:flex;align-items:center;gap:12px;pointer-events:auto;font:12.5px ui-monospace,Menlo,Consolas,monospace;line-height:1.55;}
.ob-coord span{color:#8ba3bd;display:inline-block;width:32px;}
.ob-bar{display:flex;gap:12px;align-items:center;}
.ob-seg{flex:1;display:flex;padding:4px;gap:4px;border:1px solid #1b4560;border-radius:12px;background:rgba(8,20,36,.9);pointer-events:auto;}
.ob-seg button{flex:1;height:38px;border:0;border-radius:9px;background:transparent;font-size:16px;color:#cfe4ff;}
.ob-seg button.on{background:#1c7aa0;color:#fff;}
.ob-chipbar{position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);left:14px;right:14px;display:none;justify-content:space-between;align-items:center;gap:10px;}
.ob-chip{padding:10px 14px;border-radius:14px;border:1px solid #1d4660;background:rgba(8,20,36,.92);font-size:14px;min-width:0;max-width:75%;pointer-events:auto;display:flex;align-items:center;gap:10px;}
.ob-chip b{font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ob-chip em{font-style:normal;font-size:12px;color:#8ba3bd;display:block;}
.ob-home.sheet .ob-top,.ob-home.sheet .ob-side,.ob-home.sheet .ob-bottom{display:none;}
.ob-home.sheet .ob-chipbar{display:flex;}

.ob-label{position:absolute;left:0;top:0;display:none;align-items:center;gap:8px;margin:-15px 0 0 -15px;pointer-events:none;z-index:2;}
.ob-label .ring{width:30px;height:30px;border-radius:50%;border:2px solid #19c3f0;background:rgba(25,195,240,.18);box-shadow:0 0 12px #19c3f0;}
.ob-label .txt{padding:6px 10px;border-radius:8px;border:1px solid #1d4660;background:rgba(8,20,36,.92);font-size:12.5px;white-space:nowrap;}

.ob-sheet{position:absolute;left:0;right:0;bottom:0;max-height:62vh;display:none;flex-direction:column;pointer-events:auto;
  background:linear-gradient(180deg,#0a1626,#06101e);border-top:1px solid #1d4660;border-radius:22px 22px 0 0;
  padding:10px 16px calc(env(safe-area-inset-bottom,0px) + 14px);box-shadow:0 -10px 40px rgba(0,0,0,.55);}
.ob-grab{width:44px;height:4px;border-radius:2px;background:#2b4b66;margin:0 auto 12px;flex:0 0 auto;}
.ob-tabs2{display:flex;gap:10px;flex:0 0 auto;margin-bottom:12px;}
.ob-tabs2 button{flex:1;height:42px;border-radius:12px;border:1px solid #1d3f58;background:rgba(10,24,42,.9);font-size:14.5px;}
.ob-tabs2 button.on{border-color:#7b6cff;background:rgba(123,108,255,.18);}
.ob-sheet-scroll{overflow-y:auto;flex:1;min-height:0;}
.ob-selchips{display:flex;gap:8px;overflow-x:auto;margin-bottom:10px;}
.ob-selchips:empty{display:none;}
.ob-selchips button{flex:0 0 auto;padding:6px 12px;border-radius:14px;border:1px solid #1d3f58;background:rgba(10,24,42,.9);font-size:12.5px;white-space:nowrap;}
.ob-selchips button.on{border-color:#19c3f0;}
.ob-sathead{display:flex;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid #123247;}
.ob-thumb{width:68px;height:60px;border-radius:10px;overflow:hidden;border:1px solid #1d4660;flex:0 0 auto;}
.ob-sathead .nm{flex:1;min-width:0;}
.ob-sathead .nm b{display:block;font-weight:500;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ob-sathead .nm em{font-style:normal;color:#8ba3bd;font-size:13.5px;display:block;margin:2px 0;}
.ob-sathead .nm .vs{font-size:13.5px;color:#22d36b;}
.ob-sathead .nm .vs.off{color:#a9b4c4;}
.ob-badge{padding:5px 12px;border-radius:12px;border:1px solid #2b5578;font-size:12.5px;}
.ob-three{display:flex;padding:12px 0;border-bottom:1px solid #123247;}
.ob-three > div{flex:1;display:flex;align-items:center;gap:8px;min-width:0;}
.ob-three > div + div{border-left:1px solid #123247;padding-left:10px;}
.ob-three span{font-size:11.5px;color:#8ba3bd;display:block;white-space:nowrap;}
.ob-three b{display:block;font-weight:500;font-size:17px;color:#f2f7ff;}
.ob-facts{margin-top:12px;border:1px solid #123247;border-radius:14px;padding:12px 14px;background:rgba(8,18,32,.7);}
.ob-facts h4{margin:0 0 8px;font-weight:500;font-size:16px;}
.ob-r{display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-top:1px solid #0f2a3d;font-size:14px;}
.ob-r:first-of-type{border-top:0;}
.ob-r span{color:#a9bdd3;}
.ob-r b{font-weight:400;text-align:right;}
.ob-btn{width:100%;height:48px;border-radius:14px;border:1px solid #2b8fb8;background:linear-gradient(180deg,#14607f,#0d4560);font-size:16px;margin-top:12px;flex:0 0 auto;}
.ob-btn.ghost{background:rgba(10,24,42,.9);border-color:#1d4660;}

.ob-screen{position:absolute;inset:0;display:none;flex-direction:column;pointer-events:auto;background:linear-gradient(180deg,#071322,#040b16);}
.ob-searchrow{display:flex;gap:10px;padding:calc(env(safe-area-inset-top,0px) + 12px) 14px 0;}
.ob-search{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:0 14px;height:48px;border:1px solid #1d4660;border-radius:14px;background:rgba(10,24,42,.92);color:#9fb6d3;}
.ob-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#eaf2ff;font:15px "Inter","Segoe UI",system-ui,sans-serif;}
.ob-chips{display:flex;gap:10px;padding:14px;}
.ob-chips button{flex:1;height:42px;border-radius:12px;border:1px solid #1d3f58;background:rgba(10,24,42,.9);font-size:14.5px;}
.ob-chips button.on{border-color:#19c3f0;background:rgba(25,195,240,.16);}
.ob-listhead{display:flex;justify-content:space-between;align-items:center;padding:0 14px 10px;}
.ob-listhead .c{font-size:15px;}
.ob-sort{display:flex;align-items:center;gap:6px;padding:8px 12px;border:1px solid #1d3f58;border-radius:12px;background:rgba(10,24,42,.9);font-size:13.5px;color:#a9bdd3;position:relative;}
.ob-sort select{appearance:none;-webkit-appearance:none;border:0;outline:0;background:transparent;color:#f2f7ff;font:500 13.5px "Inter","Segoe UI",system-ui,sans-serif;padding-right:4px;}
.ob-sort select option{background:#0a1626;color:#e8f1ff;}
.ob-scroll{flex:1;min-height:0;overflow-y:auto;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 70px);-webkit-overflow-scrolling:touch;}
.ob-inner{position:relative;width:100%;}
.ob-rows{position:absolute;left:0;right:0;top:0;}
.ob-row{height:${ROW}px;display:flex;align-items:center;gap:12px;padding:0 14px;border-top:1px solid #0f2a3d;cursor:pointer;}
.ob-row.sel{background:rgba(25,195,240,.1);}
.ob-ring{flex:0 0 auto;width:52px;height:52px;border-radius:50%;border:1.5px solid #1d6f93;background:rgba(14,40,66,.9);display:flex;align-items:center;justify-content:center;}
.ob-row.sel .ob-ring{border-color:#19c3f0;box-shadow:0 0 10px rgba(25,195,240,.5);}
.ob-rm{flex:1;min-width:0;}
.ob-rm b{display:block;font-weight:500;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ob-rm em{display:block;font-style:normal;font-size:12.5px;color:#8ba3bd;line-height:1.35;}
.ob-rs{flex:0 0 auto;font-size:13px;color:#cfe0f0;display:flex;align-items:center;}

.ob-nav{position:absolute;left:0;right:0;bottom:0;height:calc(env(safe-area-inset-bottom,0px) + 68px);padding-bottom:env(safe-area-inset-bottom,0px);
  display:none;pointer-events:auto;background:linear-gradient(180deg,rgba(6,14,26,.92),#050c18);border-top:1px solid #123247;z-index:3;}
.ob-nav button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;background:transparent;color:#8ba3bd;font-size:12px;}
.ob-nav button.on{color:#19c3f0;}

.ob-detail{z-index:4;}
.ob-hero{position:relative;height:200px;flex:0 0 auto;}
.ob-hero .ob-icon{position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);left:14px;}
.ob-dscroll{flex:1;min-height:0;overflow-y:auto;padding:0 16px 8px;}
.ob-dh{display:flex;justify-content:space-between;align-items:center;padding:14px 0 12px;}
.ob-dn{font-size:19px;font-weight:500;display:flex;align-items:center;}
.ob-ds{color:#a9bdd3;font-size:14px;margin-top:6px;}
.ob-dtabs{display:flex;border-bottom:1px solid #123247;margin-top:4px;}
.ob-dtabs button{flex:1;height:46px;border:0;background:transparent;color:#a9bdd3;font-size:14.5px;position:relative;}
.ob-dtabs button.on{color:#19c3f0;}
.ob-dtabs button.on::after{content:"";position:absolute;left:8%;right:8%;bottom:-1px;height:2px;background:#19c3f0;}
.ob-note{margin-top:14px;padding:14px;border:1px solid #1d4660;border-radius:14px;background:rgba(10,30,52,.8);font-size:13.5px;line-height:1.5;color:#cfe0f0;}
.ob-pos{margin-top:12px;padding:14px;border:1px solid #1d4660;border-radius:14px;background:rgba(8,18,32,.7);font-size:14px;}
.ob-pos .row{display:flex;gap:22px;margin-top:6px;color:#cfe0f0;}
.ob-pos .row span{color:#8ba3bd;margin-right:6px;}
.ob-dfoot{padding:8px 16px calc(env(safe-area-inset-bottom,0px) + 14px);flex:0 0 auto;}
.ob-dfoot .ob-btn{margin-top:0;}

.ob-more{position:absolute;inset:0;display:none;align-items:flex-end;background:rgba(0,0,0,.55);pointer-events:auto;z-index:6;}
.ob-moresheet{width:100%;max-height:75vh;overflow-y:auto;background:linear-gradient(180deg,#0a1626,#06101e);border-top:1px solid #1d4660;border-radius:22px 22px 0 0;padding:10px 16px calc(env(safe-area-inset-bottom,0px) + 18px);}
.ob-moresheet h3{margin:6px 0 10px;font-weight:500;font-size:16px;}
.ob-mrow{display:flex;align-items:center;justify-content:space-between;padding:14px 4px;border-bottom:1px solid #0f2a3d;font-size:15px;}
.ob-sw{width:46px;height:26px;border-radius:13px;border:1px solid #2b5578;background:#0a1626;position:relative;padding:0;}
.ob-sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#8ba3bd;transition:transform .15s;}
.ob-sw.on{border-color:#19c3f0;background:rgba(25,195,240,.25);}
.ob-sw.on::after{transform:translateX(20px);background:#19c3f0;}
.ob-ml button{display:block;width:100%;text-align:left;padding:12px 14px;margin-top:8px;border-radius:12px;border:1px solid #1d3f58;background:rgba(10,24,42,.9);font-size:14.5px;}
`;
document.head.appendChild(styleEl);

const root = document.createElement('div');
root.className = 'ob-root';
root.innerHTML = `
<div class="ob-home" id="ob-home">
  <div class="ob-top">
    <div class="ob-head">
      <div class="ob-logo">${ICON.logo}</div>
      <div class="ob-ttl"><div class="a">ORBIT</div><div class="b">REAL-TIME SATELLITE TRACKING</div></div>
      <button class="ob-icon" id="ob-menu" style="border:0;background:transparent">${ICON.menu}</button>
    </div>
    <div class="ob-card ob-stats">
      <div class="ob-st">${ICON.sat}<div><div class="ob-l">Active Satellites</div><div class="ob-v" id="ob-total">0</div></div></div>
      <div class="ob-st"><div><div class="ob-l"><i class="gd"></i>Currently Visible</div><div class="ob-v" id="ob-vis">0</div></div></div>
    </div>
  </div>
  <div class="ob-side">
    <button class="ob-icon" id="ob-locate" title="My location">${ICON.locate}</button>
    <button class="ob-icon on" id="ob-layers" title="Orbit lines">${ICON.layers}</button>
    <button class="ob-icon" id="ob-reset" title="Reset view">${ICON.globe}</button>
  </div>
  <div class="ob-bottom">
    <div class="ob-card ob-coord">${ICON.compass}<div><div><span>Lat</span><b id="ob-lat" style="font-weight:400">—</b></div><div><span>Lon</span><b id="ob-lon" style="font-weight:400">—</b></div><div><span>Alt</span><b id="ob-alt" style="font-weight:400">—</b></div></div></div>
    <div class="ob-bar">
      <div class="ob-seg"><button id="ob-2d">2D</button><button id="ob-3d" class="on">3D</button></div>
      <button class="ob-icon" id="ob-expand" title="Focus selected / reset">${ICON.expand}</button>
    </div>
  </div>
  <div class="ob-chipbar">
    <div class="ob-chip" id="ob-chip"></div>
    <button class="ob-icon" id="ob-close" title="Clear selection">${ICON.x}</button>
  </div>
</div>

<div class="ob-label" id="ob-label"><i class="ring"></i><span class="txt"></span></div>

<div class="ob-sheet" id="ob-sheet">
  <div class="ob-grab"></div>
  <div class="ob-tabs2"><button data-t="info" class="on">Info</button><button data-t="orbit">Orbit</button></div>
  <div class="ob-sheet-scroll">
    <div class="ob-selchips" id="ob-selchips"></div>
    <div id="ob-sheet-body"></div>
    <button class="ob-btn ghost" id="ob-viewdet">View details</button>
  </div>
</div>

<div class="ob-screen" id="ob-sats">
  <div class="ob-searchrow">
    <div class="ob-search">${ICON.search}<input id="ob-search" placeholder="Search satellite or NORAD ID…" /></div>
    <button class="ob-icon" id="ob-filter" title="Reset filters">${ICON.sliders}</button>
  </div>
  <div class="ob-chips" id="ob-chips">
    <button data-f="ALL" class="on">All</button><button data-f="LEO">LEO</button><button data-f="MEO">MEO</button><button data-f="GEO">GEO</button>
  </div>
  <div class="ob-listhead">
    <span class="c" id="ob-count">0 satellites</span>
    <label class="ob-sort">Sort by:
      <select id="ob-sort"><option value="name">Name</option><option value="alt">Altitude</option><option value="norad">NORAD ID</option></select>${ICON.down}
    </label>
  </div>
  <div class="ob-scroll" id="ob-scroll"><div class="ob-inner" id="ob-inner"><div class="ob-rows" id="ob-rows"></div></div></div>
</div>

<div class="ob-screen ob-detail" id="ob-detail">
  <div class="ob-hero">${satArt('0 0 390 220')}<button class="ob-icon" id="ob-back">${ICON.back}</button></div>
  <div class="ob-dscroll" id="ob-dscroll">
    <div id="ob-dhead"></div>
    <div id="ob-dstats"></div>
    <div class="ob-dtabs" id="ob-dtabs"><button data-t="overview" class="on">Overview</button><button data-t="orbit">Orbit</button><button data-t="technical">Technical</button></div>
    <div id="ob-dtab"></div>
  </div>
  <div class="ob-dfoot"><button class="ob-btn" id="ob-track">◎ &nbsp;Track Satellite</button></div>
</div>

<div class="ob-nav" id="ob-nav">
  <button data-n="home" class="on">${ICON.home}Home</button>
  <button data-n="sats">${ICON.satNav}Satellites</button>
  <button data-n="search">${ICON.search}Search</button>
  <button data-n="more">${ICON.more}More</button>
</div>

<div class="ob-more" id="ob-more">
  <div class="ob-moresheet">
    <div class="ob-grab"></div>
    <h3>More</h3>
    <div class="ob-mrow">Multi-select<button class="ob-sw" id="ob-multi"></button></div>
    <div class="ob-mrow">Orbit lines &amp; ground tracks<button class="ob-sw on" id="ob-lines"></button></div>
    <div class="ob-mrow" style="border:0"><span>Clear selection</span><button class="ob-icon" id="ob-clear" style="width:38px;height:38px">${ICON.x}</button></div>
    <h3>ML-tested satellites</h3>
    <div class="ob-ml" id="ob-ml"></div>
  </div>
</div>
`;
document.body.appendChild(root);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const homeEl = $('ob-home');
const labelEl = $('ob-label');
const sheetEl = $('ob-sheet');
const satsEl = $('ob-sats');
const detailEl = $('ob-detail');
const navEl = $('ob-nav');
const moreEl = $('ob-more');
const searchInput = $<HTMLInputElement>('ob-search');
const scrollEl = $('ob-scroll');
const innerEl = $('ob-inner');
const rowsEl = $('ob-rows');
const tmp = new THREE.Vector3();

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
    `<div style="margin-top:12px"><b>Prediction error vs forecast time</b><br>` +
    `<span style="color:#f66">■ SGP4</span> <span style="color:#6f6">■ SGP4 + ML</span><br>` +
    `<span style="font-size:12px">Median error at ${res.buckets[last]} h: ${pct.toFixed(0)}%</span>` +
    rows +
    `<div style="font-size:11px;opacity:.7;margin-top:6px">Median km vs the next official TLE, tested on 2025 data.</div></div>`
  );
}
function mlBlock(s: Sat): string {
  const res = mlResults[String(s.satrec.satnum)];
  return res
    ? renderMl(res)
    : '<div style="font-size:12px;opacity:.7;margin-top:12px">No ML correction trained for this satellite.</div>';
}

// ---------- satellite details (derived from the TLE) ----------
function periodMinutes(s: Sat): number {
  const rec: any = s.satrec;
  const no: number | undefined = rec.no_kozai ?? rec.no; // rad/min
  return no ? (2 * Math.PI) / no : 100;
}
function launchYear(s: Sat): string {
  const yy = parseInt(s.intl.slice(0, 2), 10);
  if (Number.isNaN(yy)) return '—';
  return String(yy >= 57 ? 1900 + yy : 2000 + yy);
}
function designator(s: Sat): string {
  return s.intl.length >= 3 ? `${launchYear(s)}-${s.intl.slice(2)}` : '—';
}
const ORBIT_NAME: Record<string, string> = {
  LEO: 'Low Earth Orbit (LEO)',
  MEO: 'Medium Earth Orbit (MEO)',
  GEO: 'Geostationary Orbit (GEO)',
  HEO: 'High Earth Orbit (HEO)',
};
function status(s: Sat): { txt: string; on: boolean } {
  if (observer) return s.elev > 0 ? { txt: 'Visible', on: true } : { txt: 'Not visible', on: false };
  return { txt: s.ok ? 'Tracking' : 'No data', on: s.ok };
}
const rowsHtml = (rows: [string, string][]) =>
  rows.map(([a, b]) => `<div class="ob-r"><span>${a}</span><b>${b}</b></div>`).join('');

function threeStats(s: Sat): string {
  return (
    `<div class="ob-three">` +
    `<div>${ICON.alt}<div><span>Altitude</span><b>${s.altKm.toFixed(0)} km</b></div></div>` +
    `<div>${ICON.speed}<div><span>Speed</span><b>${s.speedKms.toFixed(1)} km/s</b></div></div>` +
    `<div>${ICON.period}<div><span>Period</span><b>${periodMinutes(s).toFixed(1)} min</b></div></div></div>`
  );
}
function quickFacts(s: Sat): [string, string][] {
  const rec: any = s.satrec;
  return [
    ['Orbit Type', ORBIT_NAME[orbitClass(s.altKm)]],
    ['Inclination', ((rec.inclo * 180) / Math.PI).toFixed(1) + '°'],
    ['Eccentricity', Number(rec.ecco).toFixed(4)],
    ['Launch Year', launchYear(s)],
    ['Int’l Designator', designator(s)],
  ];
}
function orbitRows(s: Sat): [string, string][] {
  const rec: any = s.satrec;
  const no: number = rec.no_kozai ?? rec.no;
  const deg = (r: number) => ((r * 180) / Math.PI).toFixed(2) + '°';
  return [
    ['Altitude', s.altKm.toFixed(1) + ' km'],
    ['Speed', s.speedKms.toFixed(2) + ' km/s'],
    ['Period', periodMinutes(s).toFixed(1) + ' min'],
    ['Mean motion', no ? ((no * 1440) / (2 * Math.PI)).toFixed(4) + ' rev/day' : '—'],
    ['Inclination', deg(rec.inclo)],
    ['RAAN', deg(rec.nodeo)],
    ['Arg. of perigee', deg(rec.argpo)],
  ];
}
function technicalRows(s: Sat): [string, string][] {
  const rec: any = s.satrec;
  const jd = rec.jdsatepoch + (rec.jdsatepochF || 0);
  const ep = new Date((jd - 2440587.5) * 86400000);
  return [
    ['NORAD ID', String(rec.satnum)],
    ['Int’l Designator', designator(s)],
    ['TLE epoch', Number.isNaN(ep.getTime()) ? '—' : ep.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
    ['Eccentricity', Number(rec.ecco).toFixed(6)],
    ['BSTAR drag', Number(rec.bstar).toExponential(3)],
    ['Mean anomaly', ((rec.mo * 180) / Math.PI).toFixed(2) + '°'],
  ];
}
function posCard(s: Sat): string {
  return (
    `<div class="ob-pos"><b style="font-weight:500">Current Position</b>` +
    `<div class="row"><div><span>Lat</span>${Math.abs(s.lat).toFixed(4)}° ${s.lat >= 0 ? 'N' : 'S'}</div>` +
    `<div><span>Lon</span>${Math.abs(s.lon).toFixed(4)}° ${s.lon >= 0 ? 'E' : 'W'}</div></div></div>`
  );
}

function renderSheet() {
  if (!primary) return;
  const s = primary;
  const st = status(s);
  const n = selectedSet.size;
  $('ob-chip').innerHTML =
    `<div style="min-width:0"><b>${esc(s.name)}</b><em>(${s.satrec.satnum})${n > 1 ? ` · +${n - 1} more` : ''}</em></div>`;
  let html: string;
  if (sheetTab === 'info') {
    html =
      `<div class="ob-sathead"><div class="ob-thumb">${satArt('95 25 200 150')}</div>` +
      `<div class="nm"><b>${esc(s.name)}</b><em>(${s.satrec.satnum})</em><div class="vs${st.on ? '' : ' off'}"><i class="gd${st.on ? '' : ' off'}"></i>${st.txt}</div></div>` +
      `<span class="ob-badge">${orbitClass(s.altKm)}</span></div>` +
      threeStats(s) +
      `<div class="ob-facts"><h4>Quick Facts</h4>${rowsHtml(quickFacts(s))}</div>`;
  } else {
    html =
      `<div class="ob-facts" style="margin-top:0"><h4>Orbit</h4>${rowsHtml(orbitRows(s))}${mlBlock(s)}</div>` + posCard(s);
  }
  $('ob-sheet-body').innerHTML = html;
}

function renderDetail() {
  if (!primary) return;
  const s = primary;
  const st = status(s);
  $('ob-dhead').innerHTML =
    `<div class="ob-dh"><div><div class="ob-dn"><i class="gd${st.on ? '' : ' off'}" style="width:10px;height:10px;margin-right:10px"></i>${esc(s.name)}</div>` +
    `<div class="ob-ds">(NORAD ${s.satrec.satnum})</div></div><span class="ob-badge">${orbitClass(s.altKm)}</span></div>`;
  $('ob-dstats').innerHTML = threeStats(s);
  let html = '';
  if (detailTab === 'overview') {
    const perDay = 1440 / periodMinutes(s);
    html =
      `<div class="ob-note">${esc(s.name)} is a ${orbitClass(s.altKm)} satellite circling Earth at about ${s.altKm.toFixed(0)} km, ` +
      `completing roughly ${perDay.toFixed(1)} orbits per day. Currently ${st.txt.toLowerCase()}.</div>` +
      `<div class="ob-facts">${rowsHtml(quickFacts(s))}</div>` +
      posCard(s);
  } else if (detailTab === 'orbit') {
    html = `<div class="ob-facts">${rowsHtml(orbitRows(s))}${mlBlock(s)}</div>` + posCard(s);
  } else {
    html = `<div class="ob-facts">${rowsHtml(technicalRows(s))}</div>`;
  }
  $('ob-dtab').innerHTML = html;
}

function updateHome() {
  const p = primary;
  $('ob-lat').textContent = p && p.ok ? `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? 'N' : 'S'}` : '—';
  $('ob-lon').textContent = p && p.ok ? `${Math.abs(p.lon).toFixed(4)}° ${p.lon >= 0 ? 'E' : 'W'}` : '—';
  $('ob-alt').textContent = p && p.ok ? `${p.altKm.toFixed(1)} km` : '—';
}

// ---------- list screen (virtualized) ----------
let pressing = false;
let lastScroll = 0;
let lastListHtml = '';

function rebuildList() {
  let arr: number[];
  if (sortMode === 'name') {
    arr = sortedIdx.filter((i) => sats[i].matches);
  } else {
    arr = [];
    for (let i = 0; i < sats.length; i++) if (sats[i].matches) arr.push(i);
    if (sortMode === 'alt') arr.sort((a, b) => sats[a].altKm - sats[b].altKm);
    else arr.sort((a, b) => Number(sats[a].satrec.satnum) - Number(sats[b].satrec.satnum));
  }
  visibleList = arr;
  innerEl.style.height = arr.length * ROW + 'px';
  $('ob-count').textContent = `${arr.length.toLocaleString()} satellites`;
  lastListHtml = '';
  renderList(true);
}

function renderList(force = false) {
  if (screen !== 'sats') return;
  if (!force && (pressing || performance.now() - lastScroll < 300)) return;
  const top = scrollEl.scrollTop;
  const h = scrollEl.clientHeight || 600;
  const start = Math.max(0, Math.floor(top / ROW) - 3);
  const end = Math.min(visibleList.length, Math.ceil((top + h) / ROW) + 3);
  let html = '';
  for (let k = start; k < end; k++) {
    const i = visibleList[k];
    const s = sats[i];
    const st = status(s);
    html +=
      `<div class="ob-row${selectedSet.has(s) ? ' sel' : ''}" data-ref="${i}">` +
      `<span class="ob-ring">${ICON.satRing}</span>` +
      `<div class="ob-rm"><b>${esc(s.name)}</b><em>(${s.satrec.satnum})</em>` +
      `<em>${s.ok ? orbitClass(s.altKm) + ' · ' + Math.round(s.altKm).toLocaleString() + ' km' : '—'}</em></div>` +
      `<div class="ob-rs"><i class="gd${st.on ? '' : ' off'}"></i>${st.txt}</div>${ICON.chev}</div>`;
  }
  const key = start + '|' + html;
  if (key === lastListHtml) return;
  lastListHtml = key;
  rowsEl.style.transform = `translateY(${start * ROW}px)`;
  rowsEl.innerHTML = html;
}

scrollEl.addEventListener('scroll', () => {
  lastScroll = performance.now();
  renderList(true);
});
scrollEl.addEventListener('pointerdown', () => (pressing = true));
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  scrollEl.addEventListener(ev, () => (pressing = false))
);
scrollEl.addEventListener('click', (e) => {
  const r = (e.target as HTMLElement).closest('.ob-row') as HTMLElement | null;
  if (!r) return;
  const s = sats[Number(r.dataset.ref)];
  if (!s) return;
  if (multiMode) {
    toggleInSelection(s, true);
  } else {
    setSelection([s], true);
    go('detail');
  }
});

// ---------- navigation / layout ----------
function go(sc: Screen) {
  if (sc === 'detail') prevScreen = screen;
  screen = sc;
  layout();
}

function layout() {
  if (screen === 'detail' && !primary) screen = prevScreen === 'detail' ? 'home' : prevScreen;
  sheetOpen = screen === 'home' && selectedSet.size > 0 && !!primary;
  homeEl.classList.toggle('hide', screen !== 'home');
  homeEl.classList.toggle('sheet', sheetOpen);
  satsEl.style.display = screen === 'sats' ? 'flex' : 'none';
  detailEl.style.display = screen === 'detail' ? 'flex' : 'none';
  sheetEl.style.display = sheetOpen ? 'flex' : 'none';
  navEl.style.display = screen !== 'detail' && !sheetOpen ? 'flex' : 'none';
  navEl.querySelectorAll('button').forEach((b) => {
    const n = (b as HTMLElement).dataset.n;
    b.classList.toggle('on', (n === 'home' && screen === 'home') || (n === 'sats' && screen === 'sats'));
  });
  if (screen !== 'home') labelEl.style.display = 'none';
  applyViewOffset();
  if (screen === 'sats') {
    rebuildList();
  }
  if (sheetOpen) renderSheet();
  if (screen === 'detail') renderDetail();
  draw2d();
}

function renderSelChips() {
  const box = $('ob-selchips');
  if (selectedSet.size < 2) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = Array.from(selectedSet)
    .slice(0, 12)
    .map((s) => `<button data-i="${sats.indexOf(s)}" class="${s === primary ? 'on' : ''}">${esc(s.name)}</button>`)
    .join('');
}
$('ob-selchips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
  if (!b) return;
  const s = sats[Number(b.dataset.i)];
  if (!s) return;
  primary = s;
  primaryIdx = sats.indexOf(s);
  renderSelChips();
  renderSheet();
});

navEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
  if (!b) return;
  const n = b.dataset.n;
  if (n === 'home') go('home');
  else if (n === 'sats') go('sats');
  else if (n === 'search') {
    go('sats');
    searchInput.focus();
  } else openMore();
});
$('ob-menu').addEventListener('click', openMore);

function openMore() {
  moreEl.style.display = 'flex';
}
function closeMore() {
  moreEl.style.display = 'none';
}
moreEl.addEventListener('click', (e) => {
  if (e.target === moreEl) closeMore();
});
function setMulti(v: boolean) {
  multiMode = v;
  $('ob-multi').classList.toggle('on', v);
}
$('ob-multi').addEventListener('click', () => setMulti(!multiMode));
$('ob-lines').addEventListener('click', () => setLines(!showLines));
$('ob-clear').addEventListener('click', () => {
  setSelection([], false);
  closeMore();
});

function setLines(v: boolean) {
  showLines = v;
  orbitGroup.visible = v;
  $('ob-lines').classList.toggle('on', v);
  $('ob-layers').classList.toggle('on', v);
  draw2d();
}
$('ob-layers').addEventListener('click', () => setLines(!showLines));

function setView(m: '3d' | '2d') {
  viewMode = m;
  renderer.domElement.style.display = m === '3d' ? 'block' : 'none';
  map2d.style.display = m === '2d' ? 'block' : 'none';
  controls.enabled = m === '3d';
  $('ob-2d').classList.toggle('on', m === '2d');
  $('ob-3d').classList.toggle('on', m === '3d');
  applyViewOffset();
  draw2d();
}
$('ob-2d').addEventListener('click', () => setView('2d'));
$('ob-3d').addEventListener('click', () => setView('3d'));

function resetView() {
  camera.position.set(0, 0, 400);
  controls.update();
  panX = 0;
  draw2d();
}
$('ob-reset').addEventListener('click', resetView);
$('ob-expand').addEventListener('click', () => {
  if (primary && primary.ok) {
    focusOn(primary);
    if (viewMode === '2d') {
      const g = mapGeom();
      panX = g.W / 2 - (primary.lon + 180) * g.sc;
      draw2d();
    }
  } else resetView();
});

$('ob-locate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported in this browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setObserver(pos.coords.latitude, pos.coords.longitude),
    () => alert('Could not get your location. Allow location access and try again.')
  );
});
function setObserver(lat: number, lon: number) {
  observer = { lat, lon };
  const c = globe.getCoords(lat, lon, 0.002);
  obsMarker.position.set(c.x, c.y, c.z);
  obsMarker.visible = true;
  const dir = new THREE.Vector3(c.x, c.y, c.z).normalize();
  camera.position.copy(dir.multiplyScalar(Math.max(camera.position.length(), 220)));
  controls.update();
  update();
}

// sheet / detail interactions
$('ob-close').addEventListener('click', () => setSelection([], false));
$('ob-viewdet').addEventListener('click', () => go('detail'));
$('ob-back').addEventListener('click', () => go(prevScreen === 'detail' ? 'home' : prevScreen));
$('ob-track').addEventListener('click', () => {
  if (primary) focusOn(primary);
  go('home');
});
sheetEl.querySelector('.ob-tabs2')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
  if (!b) return;
  sheetTab = b.dataset.t as 'info' | 'orbit';
  sheetEl.querySelectorAll('.ob-tabs2 button').forEach((x) => x.classList.toggle('on', x === b));
  renderSheet();
});
$('ob-dtabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
  if (!b) return;
  detailTab = b.dataset.t as 'overview' | 'orbit' | 'technical';
  $('ob-dtabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderDetail();
});

// list filters
function setChip(f: OrbitFilter) {
  orbitFilter = f;
  $('ob-chips').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('on', (b as HTMLElement).dataset.f === f)
  );
}
$('ob-chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
  if (!b) return;
  setChip(b.dataset.f as OrbitFilter);
  applyFilter();
});
$<HTMLSelectElement>('ob-sort').addEventListener('change', (e) => {
  sortMode = (e.target as HTMLSelectElement).value as 'name' | 'alt' | 'norad';
  rebuildList();
});
$('ob-filter').addEventListener('click', () => {
  searchInput.value = '';
  setChip('ALL');
  $<HTMLSelectElement>('ob-sort').value = 'name';
  sortMode = 'name';
  applyFilter();
});

// ML-tested satellites (inside "More")
function buildChips() {
  const box = $('ob-ml');
  box.innerHTML = '';
  for (const key of Object.keys(mlResults)) {
    const s = sats.find((x) => String(x.satrec.satnum) === key);
    if (!s) continue;
    const b = document.createElement('button');
    b.textContent = s.name;
    b.addEventListener('click', () => {
      closeMore();
      searchInput.value = '';
      setChip('ALL');
      applyFilter();
      go('home');
      if (multiMode) toggleInSelection(s, true);
      else setSelection([s], true);
    });
    box.appendChild(b);
  }
}

// ---------- data ----------
fetch('/ml_results.json')
  .then((r) => r.json())
  .then((j) => {
    mlResults = j;
    buildChips();
    refreshPanels();
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
      elev: -90,
      intl: l1.substring(9, 17).trim(),
    });
  }
}

// ---------- positions ----------
function update() {
  const now = new Date();
  const gmst = satellite.gstime(now);
  let shown = 0;
  let vis = 0;
  const obsGd = observer
    ? {
        longitude: satellite.degreesToRadians(observer.lon),
        latitude: satellite.degreesToRadians(observer.lat),
        height: 0,
      }
    : null;

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
    if (obsGd) {
      const ecf = satellite.eciToEcf(pv.position, gmst);
      s.elev = (satellite.ecfToLookAngles(obsGd, ecf).elevation * 180) / Math.PI;
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
    if (obsGd && s.elev > 0) vis++;
  }
  cloudGeom.attributes.position.needsUpdate = true;
  $('ob-total').textContent = sats.length.toLocaleString();
  $('ob-vis').textContent = (observer ? vis : shown).toLocaleString();

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
  refreshPanels();
}

function refreshPanels() {
  updateHome();
  if (sheetOpen) renderSheet();
  if (screen === 'detail') renderDetail();
  renderList(false);
  draw2d();
}

// ---------- orbit rings + ground tracks ----------
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
  primaryIdx = primary ? sats.indexOf(primary) : -1;
  rebuildSelGeometry();
  buildOrbitLines();
  update();
  renderSelChips();
  layout();
  renderList(true);
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

// ---------- search / filter ----------
function applyFilter() {
  const q = searchInput.value.trim().toUpperCase();
  for (const s of sats) {
    const text = q === '' || s.name.toUpperCase().includes(q) || String(s.satrec.satnum) === q;
    s.matches = text && (orbitFilter === 'ALL' || orbitClass(s.altKm) === orbitFilter);
  }
  update();
  rebuildList();
}
searchInput.addEventListener('input', applyFilter);

// ---------- tap to pick (nearest satellite on screen, not hidden behind Earth) ----------
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

function pickAt2d(px: number, py: number): number {
  const g = mapGeom();
  let best = -1;
  let bestD = PICK_RADIUS_PX;
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    if (!s.ok || !s.matches) continue;
    const [x, y] = xy2d(s.lat, s.lon, g);
    const dx = Math.abs((((x - px + g.mw / 2) % g.mw) + g.mw) % g.mw - g.mw / 2);
    const d = Math.hypot(dx, y - py);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function handleTap(i: number) {
  if (i >= 0) {
    if (multiMode) toggleInSelection(sats[i], false);
    else setSelection([sats[i]], false);
  } else if (!multiMode) {
    setSelection([], false);
  }
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
    handleTap(pickAt(e.clientX - rect.left, e.clientY - rect.top));
  }
});

// 2D map: drag to pan, tap to pick
let d2 = { x: 0, y: 0, t: 0, px: 0, down: false, drag: false };
map2d.addEventListener('pointerdown', (e: PointerEvent) => {
  d2 = { x: e.clientX, y: e.clientY, t: performance.now(), px: panX, down: true, drag: false };
  map2d.setPointerCapture(e.pointerId);
});
map2d.addEventListener('pointermove', (e: PointerEvent) => {
  if (!d2.down) return;
  const dx = e.clientX - d2.x;
  if (Math.abs(dx) > 8) d2.drag = true;
  if (d2.drag) {
    panX = d2.px + dx;
    draw2d();
  }
});
map2d.addEventListener('pointerup', (e: PointerEvent) => {
  const wasDrag = d2.drag || Math.hypot(e.clientX - d2.x, e.clientY - d2.y) >= 8;
  const quick = performance.now() - d2.t < 500;
  d2.down = false;
  d2.drag = false;
  if (!wasDrag && quick) handleTap(pickAt2d(e.clientX, e.clientY));
});

// ---------- start ----------
function updateLabel3d() {
  const txt = labelEl.querySelector('.txt') as HTMLElement;
  if (primary) txt.textContent = primary.name;
  if (viewMode !== '3d') return;
  if (!primary || primaryIdx < 0 || !primary.ok || !primary.matches || screen !== 'home') {
    labelEl.style.display = 'none';
    return;
  }
  const i = primaryIdx;
  tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).project(camera);
  if (tmp.z > 1 || occluded(i)) {
    labelEl.style.display = 'none';
    return;
  }
  const x = (tmp.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-tmp.y * 0.5 + 0.5) * window.innerHeight;
  labelEl.style.display = 'flex';
  labelEl.style.transform = `translate(${x}px,${y}px)`;
}

(function animate() {
  requestAnimationFrame(animate);
  if (viewMode === '3d') {
    controls.update();
    renderer.render(scene, camera);
  }
  updateLabel3d();
})();

async function main() {
  try {
    parseSatellites(await loadTleText());
    sortedIdx = sats.map((_, i) => i).sort((a, b) => collator.compare(sats[a].name, sats[b].name));
    buildCloud();
    buildChips();
    update();
    layout();
    setInterval(update, 1000);
  } catch (err) {
    console.error(err);
    $('ob-vis').textContent = '—';
    $('ob-total').textContent = 'Load failed';
  }
}
main();