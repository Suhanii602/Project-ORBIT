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
  animation: false,
  timeline: false,
});
viewer.scene.backgroundColor = Color.fromCssColorString('#02060f');

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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- UI ----------
const BOX =
  'padding:10px 14px;background:rgba(5,13,26,.9);color:#e8f1ff;' +
  'font:14px "Inter","Segoe UI",system-ui,sans-serif;border-radius:12px;' +
  'border:1px solid #14384f;box-shadow:0 8px 30px rgba(0,0,0,.45);backdrop-filter:blur(6px);';

// Styles for the control panel (UI only)
const uiStyle = document.createElement('style');
uiStyle.textContent = `
  .sp-panel{position:absolute;top:0;left:0;bottom:0;width:340px;min-width:260px;max-width:95vw;
    z-index:10;box-sizing:border-box;resize:horizontal;overflow:hidden;display:flex;flex-direction:column;
    background:linear-gradient(180deg,#071322,#050d19);color:#e8f1ff;
    border-right:1px solid #14384f;padding:14px 14px 0;
    font-family:"Inter","Segoe UI",system-ui,sans-serif;
    box-shadow:6px 0 40px rgba(0,0,0,.55);backdrop-filter:blur(8px);}
  .sp-panel.collapsed{bottom:auto;resize:none;width:auto!important;min-width:0;padding-bottom:14px;
    border-bottom:1px solid #14384f;border-radius:0 0 14px 0;}

  .sp-head{position:relative;display:flex;align-items:center;gap:12px;padding-bottom:14px;
    border-bottom:1px solid #123247;flex:0 0 auto;}
  .sp-head::after{content:"";position:absolute;left:0;bottom:-1px;width:74px;height:2px;background:#19c3f0;}
  .sp-logo{flex:0 0 auto;width:48px;height:48px;border:1px solid #1d4660;border-radius:10px;
    background:#0a1a2c;display:flex;align-items:center;justify-content:center;}
  .sp-title{flex:1;min-width:0;}
  .sp-title .t1{font:500 22px "Inter","Segoe UI",system-ui,sans-serif;letter-spacing:.2em;color:#f2f7ff;}
  .sp-title .t2{margin-top:3px;font:10px ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    letter-spacing:.16em;color:#6f93ad;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .sp-toggle{flex:0 0 auto;width:30px;height:30px;border-radius:8px;border:0;background:transparent;
    color:#cfe4ff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
  .sp-toggle:hover{background:rgba(25,195,240,.12);}
  .sp-panel.collapsed .sp-head{border-bottom:0;padding-bottom:0;}
  .sp-panel.collapsed .sp-head::after{display:none;}

  .sp-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;margin-top:14px;}
  .sp-panel.collapsed .sp-body{display:none;}

  .sp-stats{display:flex;align-items:center;padding-bottom:14px;border-bottom:1px solid #123247;flex:0 0 auto;}
  .sp-stat{flex:1;display:flex;align-items:center;gap:12px;min-width:0;}
  .sp-stat + .sp-stat{border-left:1px solid #123247;padding-left:16px;}
  .sp-stat .sp-sico{flex:0 0 auto;display:inline-flex;}
  .sp-stat .lbl{font-size:13px;color:#8ba3bd;white-space:nowrap;}
  .sp-stat .val{font-size:22px;font-weight:500;color:#f2f7ff;line-height:1.25;}
  .sp-status{font-size:12px;color:#8ba3bd;margin-top:-4px;flex:0 0 auto;}
  .sp-status:empty{display:none;}

  .sp-controls{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:0 0 auto;}
  .sp-row2{display:grid;grid-template-columns:1fr auto;gap:10px;flex:0 0 auto;}
  .sp-btn{display:flex;align-items:center;gap:10px;padding:0 14px;height:46px;min-width:0;box-sizing:border-box;
    background:rgba(9,22,40,.95);color:#eaf2ff;border:1px solid #1d3f58;border-radius:10px;
    font:400 14.5px "Inter","Segoe UI",system-ui,sans-serif;cursor:pointer;text-align:left;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:border-color .15s,background .15s;}
  .sp-btn:hover{border-color:#2f84b3;background:rgba(14,32,56,.97);}
  .sp-btn .sp-ico{flex:0 0 auto;display:inline-flex;}
  .sp-btn .sp-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;}

  .sp-live{display:flex;align-items:center;gap:8px;padding:0 14px;height:46px;box-sizing:border-box;
    border:1px solid #1d3f58;border-radius:10px;background:rgba(9,22,40,.95);font-size:14.5px;color:#22d36b;}
  .sp-live i{width:8px;height:8px;border-radius:50%;background:#22d36b;box-shadow:0 0 8px #22d36b;display:inline-block;}
  .sp-live svg{opacity:.8;}

  .sp-searchrow{display:flex;gap:10px;flex:0 0 auto;}
  .sp-search{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:0 14px;height:48px;box-sizing:border-box;
    border:1px solid #1d3f58;border-radius:10px;background:rgba(9,22,40,.95);}
  .sp-search:focus-within{border-color:#2f84b3;}
  .sp-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#eaf2ff;
    font:14.5px "Inter","Segoe UI",system-ui,sans-serif;padding:0;}
  .sp-search input::placeholder{color:#6f87a8;}
  .sp-filterbtn{flex:0 0 auto;width:48px;height:48px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    border:1px solid #1d3f58;border-radius:10px;background:rgba(9,22,40,.95);cursor:pointer;padding:0;}
  .sp-filterbtn:hover{border-color:#2f84b3;}

  .sp-tabwrap{flex:1;min-height:0;display:flex;flex-direction:column;margin-bottom:12px;}
  .sp-tabs{display:grid;grid-template-columns:1fr 1fr;border:1px solid #123247;border-bottom:0;
    border-radius:10px 10px 0 0;overflow:hidden;flex:0 0 auto;background:rgba(6,16,30,.9);}
  .sp-tab{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 0;
    background:transparent;border:0;color:#8ba3bd;font:14.5px "Inter","Segoe UI",system-ui,sans-serif;cursor:pointer;}
  .sp-tab.on{color:#e8f1ff;background:rgba(25,195,240,.09);}
  .sp-tab.on::after{content:"";position:absolute;left:0;bottom:0;width:62%;height:2px;background:#19c3f0;}

  .sp-list{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid #123247;
    border-radius:0 0 10px 10px;background:rgba(6,16,30,.9);overflow:hidden;}
  .sp-list-head{display:grid;grid-template-columns:14px 34px 1fr 64px 70px;align-items:center;padding:12px;
    color:#8ba3bd;font-size:13px;border-top:1px solid #123247;border-bottom:1px solid #123247;flex:0 0 auto;}
  .sp-list-head span{cursor:pointer;user-select:none;white-space:nowrap;}
  .sp-list-head span:hover{color:#e8f1ff;}
  .sp-list-head .h-name{grid-column:1 / 4;}
  .sp-list-head .h-orb,.sp-list-head .h-alt{text-align:center;}
  .sp-list-scroll{position:relative;flex:1;overflow-y:auto;overflow-x:hidden;}
  .sp-list-inner{position:relative;width:100%;}
  .sp-list-rows{position:absolute;left:0;right:0;top:0;}
  .sp-row{height:54px;box-sizing:border-box;display:grid;grid-template-columns:14px 34px 1fr 64px 70px;
    align-items:center;padding:0 12px;border-bottom:1px solid #0f2a3d;cursor:pointer;font-size:14.5px;}
  .sp-row:hover{background:rgba(25,195,240,.06);}
  .sp-row.sel{background:rgba(25,195,240,.12);}
  .sp-row .dot{width:8px;height:8px;border-radius:50%;background:#6b7683;}
  .sp-row .dot.on{background:#22d36b;box-shadow:0 0 8px #22d36b;}
  .sp-row .rico{display:inline-flex;}
  .sp-row .rname{min-width:0;}
  .sp-row .rname b{display:block;font-weight:400;color:#e8f1ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .sp-row .rname em{display:block;font-style:normal;font-size:13.5px;color:#8ba3bd;}
  .sp-row .rorb,.sp-row .ralt{text-align:center;color:#d2e1f1;}
  .sp-filters{display:none;padding:14px;border:1px solid #123247;border-radius:0 0 10px 10px;
    background:rgba(6,16,30,.9);}

  .sp-panel::-webkit-scrollbar,.sp-list-scroll::-webkit-scrollbar,.sp-details::-webkit-scrollbar{width:8px;}
  .sp-list-scroll::-webkit-scrollbar-thumb,.sp-details::-webkit-scrollbar-thumb{background:#2b5578;border-radius:4px;}
  .sp-list-scroll::-webkit-scrollbar-track{background:rgba(255,255,255,.03);}

  .sp-tophud{position:absolute;top:14px;left:372px;z-index:10;display:none;align-items:center;gap:14px;
    color:#e8f1ff;font:13.5px ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    pointer-events:none;text-shadow:0 0 6px #000;}
  .sp-tophud .nm{color:#19c3f0;font-weight:600;margin-bottom:3px;}
  .sp-tophud .r{display:grid;grid-template-columns:34px auto;gap:6px;line-height:1.6;}
  .sp-tophud .r span{color:#8ba3bd;}
  .sp-details{position:absolute;top:118px;left:372px;width:300px;max-height:calc(100vh - 150px);z-index:8;
    box-sizing:border-box;padding:10px 14px;background:rgba(5,13,26,.9);color:#e8f1ff;
    border:1px solid #14384f;border-radius:12px;font:14px "Inter","Segoe UI",system-ui,sans-serif;
    box-shadow:0 8px 30px rgba(0,0,0,.45);backdrop-filter:blur(6px);display:none;overflow:auto;}

  .sp-clock{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:10;display:flex;align-items:center;gap:12px;
    padding:12px 18px;background:rgba(5,13,26,.9);border:1px solid #14384f;border-radius:12px;
    color:#e8f1ff;font:15px ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
    box-shadow:0 8px 30px rgba(0,0,0,.45);backdrop-filter:blur(6px);}
  .sp-rot{position:absolute;right:12px;bottom:44px;z-index:5;display:flex;align-items:center;gap:12px;padding:12px 16px;
    background:rgba(5,13,26,.88);border:1px solid #14384f;border-radius:10px;
    font-family:"Inter","Segoe UI",system-ui,sans-serif;backdrop-filter:blur(6px);}
  .sp-rot .a{font-size:12px;color:#8ba3bd;}
  .sp-rot .b{font-size:14px;color:#f2f7ff;margin-top:3px;}
  @media (max-width:1100px){.sp-clock{top:auto;bottom:34px;}}
  @media (max-width:600px){
    .sp-rot{display:none;}.sp-clock{font-size:12px;padding:8px 12px;}
    .sp-tophud{left:12px;top:78px;}
    .sp-details{left:12px;top:182px;width:calc(100vw - 24px);}
  }
`;
document.head.appendChild(uiStyle);

const ICONS = {
  pin:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="#19c3f0"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  box:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8f1ff" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  boxChecked:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12l3 3 5-6"/></svg>',
  x:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8f1ff" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
  brain:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ff4fd8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/><path d="M9 9h1M14 9h1M9 14h1M14 14h1"/></svg>',
  chevron:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#cfe4ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  search:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9fb6d3" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  menu:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#cfe4ff" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  logo:
    '<svg width="34" height="34" viewBox="0 0 48 48" fill="none" stroke="#e8f1ff" stroke-width="2" stroke-linecap="round"><ellipse cx="24" cy="24" rx="19" ry="8" transform="rotate(-35 24 24)"/><circle cx="24" cy="24" r="9"/><circle cx="38" cy="12" r="2.6" fill="#19c3f0" stroke="#19c3f0"/></svg>',
  target:
    '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  sat:
    '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M5 5l3 3M16 16l3 3M3 9l6-6M15 21l6-6M7.5 7.5L4 11M13 20l3.5-3.5"/></svg>',
  satSm:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a9d4ee" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M5 5l3 3M16 16l3 3M3 9l6-6M15 21l6-6M7.5 7.5L4 11M13 20l3.5-3.5"/></svg>',
  satTab:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9.5" y="9.5" width="5" height="5" rx="1" transform="rotate(45 12 12)"/><path d="M5 5l3 3M16 16l3 3M3 9l6-6M15 21l6-6M7.5 7.5L4 11M13 20l3.5-3.5"/></svg>',
  funnel:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8ba3bd" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6 7v6l-4 2v-8z"/></svg>',
  sliders:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#cfe4ff" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
  clock:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>',
  pulse:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#cfe4ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
  globe:
    '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#19c3f0" stroke-width="1.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14M4 20L20 4"/></svg>',
  axes:
    '<svg width="78" height="70" viewBox="0 0 78 70" fill="none" stroke="#6fd6f5" stroke-width="1"><circle cx="39" cy="38" r="22"/><ellipse cx="39" cy="38" rx="9" ry="22"/><path d="M17 38h44M39 16v44M21 28h36M21 48h36"/><text x="36" y="10" fill="#9fb6d3" stroke="none" font-size="9" font-family="sans-serif">Z</text><text x="2" y="42" fill="#9fb6d3" stroke="none" font-size="9" font-family="sans-serif">X</text><text x="67" y="42" fill="#9fb6d3" stroke="none" font-size="9" font-family="sans-serif">Y</text></svg>',
};

const column = document.createElement('div');
column.className = 'sp-panel';
document.body.appendChild(column);

const header = document.createElement('div');
header.className = 'sp-head';
header.innerHTML =
  '<span class="sp-logo">' + ICONS.logo + '</span>' +
  '<div class="sp-title"><div class="t1">ORBIT</div><div class="t2">REAL-TIME SATELLITE TRACKING</div></div>';
column.appendChild(header);

const toggleBtn = document.createElement('button');
toggleBtn.className = 'sp-toggle';
toggleBtn.title = 'Collapse / expand panel';
toggleBtn.innerHTML = ICONS.menu;
toggleBtn.addEventListener('click', () => {
  const c = column.classList.toggle('collapsed');
  if (c) {
    column.dataset.w = column.style.width;
    column.style.width = '';
  } else {
    if (column.dataset.w) column.style.width = column.dataset.w;
  }
});
   if (window.innerWidth < 600) column.classList.add('collapsed');

header.appendChild(toggleBtn);

const body = document.createElement('div');
body.className = 'sp-body';
column.appendChild(body);

// stats row: total + currently visible
const stats = document.createElement('div');
stats.className = 'sp-stats';
stats.innerHTML =
  '<div class="sp-stat"><span class="sp-sico">' + ICONS.target + '</span>' +
  '<div><div class="lbl">Total Satellites</div><div class="val" id="sp-total">0</div></div></div>' +
  '<div class="sp-stat"><span class="sp-sico">' + ICONS.sat + '</span>' +
  '<div><div class="lbl">Currently Visible</div><div class="val" id="sp-shown">0</div></div></div>';
body.appendChild(stats);
const statTotal = stats.querySelector('#sp-total') as HTMLElement;
const statShown = stats.querySelector('#sp-shown') as HTMLElement;

// status line (loading / selection count / notes)
const hud = document.createElement('div');
hud.className = 'sp-status';
hud.textContent = 'Loading satellites…';
body.appendChild(hud);

const controls = document.createElement('div');
controls.className = 'sp-controls';
body.appendChild(controls);

const row2 = document.createElement('div');
row2.className = 'sp-row2';
body.appendChild(row2);

const live = document.createElement('div');
live.className = 'sp-live';
live.innerHTML = '<i></i>Live' + ICONS.pulse;

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
  opts: { trailing?: string; parent?: HTMLElement } = {}
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sp-btn';
  b.innerHTML =
    (icon ? '<span class="sp-ico">' + icon + '</span>' : '') +
    '<span class="sp-lbl"></span>' +
    (opts.trailing ? '<span class="sp-ico">' + opts.trailing + '</span>' : '');
  setLabel(b, label);
  b.addEventListener('click', onClick);
  (opts.parent ?? controls).appendChild(b);
  return b;
}

const locBtn = makeButton('My Location', useMyLocation, ICONS.pin, { trailing: ICONS.chevron });
const multiBtn = makeButton('Multi-select', toggleMulti, ICONS.box);
const orbitBtn = makeButton('Orbits: Selected', toggleOrbitMode, '', {
  trailing: ICONS.chevron,
  parent: row2,
});
row2.appendChild(live);

// search + filters button
const searchRow = document.createElement('div');
searchRow.className = 'sp-searchrow';
body.appendChild(searchRow);

const searchWrap = document.createElement('div');
searchWrap.className = 'sp-search';
searchWrap.innerHTML = ICONS.search;
searchRow.appendChild(searchWrap);

const search = document.createElement('input');
search.placeholder = 'Search by name or NORAD ID…';
searchWrap.appendChild(search);

const filterBtn = document.createElement('button');
filterBtn.className = 'sp-filterbtn';
filterBtn.title = 'Filters';
filterBtn.innerHTML = ICONS.sliders;
filterBtn.addEventListener('click', () => showTab('filters'));
searchRow.appendChild(filterBtn);

// tabs: Satellites list / Filters
const tabWrap = document.createElement('div');
tabWrap.className = 'sp-tabwrap';
body.appendChild(tabWrap);

const tabs = document.createElement('div');
tabs.className = 'sp-tabs';
tabs.innerHTML =
  '<button class="sp-tab on" data-tab="sats">' + ICONS.satTab + 'Satellites</button>' +
  '<button class="sp-tab" data-tab="filters">' + ICONS.funnel + 'Filters</button>';
tabWrap.appendChild(tabs);
tabs.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('.sp-tab') as HTMLElement | null;
  if (t) showTab(t.dataset.tab as 'sats' | 'filters');
});

const listWrap = document.createElement('div');
listWrap.className = 'sp-list';
listWrap.innerHTML =
  '<div class="sp-list-head">' +
  '<span class="h-name" data-k="name">Name / NORAD ID</span>' +
  '<span class="h-orb" data-k="orbit">Orbit</span>' +
  '<span class="h-alt" data-k="alt">Alt (km)</span></div>' +
  '<div class="sp-list-scroll"><div class="sp-list-inner"><div class="sp-list-rows"></div></div></div>';
tabWrap.appendChild(listWrap);
const listHead = listWrap.querySelector('.sp-list-head') as HTMLElement;
const listScroll = listWrap.querySelector('.sp-list-scroll') as HTMLElement;
const listInner = listWrap.querySelector('.sp-list-inner') as HTMLElement;
const listRows = listWrap.querySelector('.sp-list-rows') as HTMLElement;

const filtersWrap = document.createElement('div');
filtersWrap.className = 'sp-filters';
tabWrap.appendChild(filtersWrap);
const controls2 = document.createElement('div');
controls2.className = 'sp-controls';
filtersWrap.appendChild(controls2);
makeButton('Clear selection', () => setSelection([]), ICONS.x, { parent: controls2 });
makeButton('ML-tested', selectMlSats, ICONS.brain, { parent: controls2 });

function showTab(name: 'sats' | 'filters') {
  tabs.querySelectorAll('.sp-tab').forEach((el) => {
    el.classList.toggle('on', (el as HTMLElement).dataset.tab === name);
  });
  listWrap.style.display = name === 'sats' ? 'flex' : 'none';
  filtersWrap.style.display = name === 'filters' ? 'block' : 'none';
  if (name === 'sats') renderList(true);
}

// ---------- satellite list (virtualized, sortable) ----------
const ROW = 54;
type SortKey = 'name' | 'orbit' | 'alt';
let sortKey: SortKey = 'name';
let sortAsc = true;
let visible: number[] = [];
let sortedIdx: number[] = [];
const collator = new Intl.Collator(undefined, { numeric: true });

function orbitClass(alt: number): string {
  if (alt < 2000) return 'LEO';
  if (alt < 35000) return 'MEO';
  if (alt <= 36500) return 'GEO';
  return 'HEO';
}

function updateHeadArrows() {
  listHead.querySelectorAll('span').forEach((el) => {
    const k = (el as HTMLElement).dataset.k as SortKey;
    const base = k === 'name' ? 'Name / NORAD ID' : k === 'orbit' ? 'Orbit' : 'Alt (km)';
    el.textContent = base + (k === sortKey ? (sortAsc ? ' ▲' : ' ▼') : '');
  });
}

function refreshIndexEntries() {
  const dir = sortAsc ? 1 : -1;
  if (sortKey === 'name') {
    const arr = sortedIdx.filter((i) => sats[i].matches);
    if (!sortAsc) arr.reverse();
    visible = arr;
  } else {
    visible = sats
      .map((_, i) => i)
      .filter((i) => sats[i].matches)
      .sort((a, b) => dir * (sats[a].altKm - sats[b].altKm));
  }
  listInner.style.height = visible.length * ROW + 'px';
  updateHeadArrows();
  renderList(true);
}

function renderList(force = false) {
  if (!force && listScroll.matches(':hover')) return;
  if (listWrap.style.display === 'none') return;
  const top = listScroll.scrollTop;
  const h = listScroll.clientHeight || 400;
  const start = Math.max(0, Math.floor(top / ROW) - 3);
  const end = Math.min(visible.length, Math.ceil((top + h) / ROW) + 3);
  let html = '';
  for (let k = start; k < end; k++) {
    const i = visible[k];
    const s = sats[i];
    const sel = selectedSet.has(s);
    html +=
      `<div class="sp-row${sel ? ' sel' : ''}" data-ref="${i}">` +
      `<span class="dot${sel ? ' on' : ''}"></span>` +
      `<span class="rico">${ICONS.satSm}</span>` +
      `<span class="rname"><b>${esc(s.name)}</b><em>(${s.satrec.satnum})</em></span>` +
      `<span class="rorb">${s.ok ? orbitClass(s.altKm) : '—'}</span>` +
      `<span class="ralt">${s.ok ? Math.round(s.altKm).toLocaleString() : '—'}</span></div>`;
  }
  listRows.style.transform = `translateY(${start * ROW}px)`;
  listRows.innerHTML = html;
}

listScroll.addEventListener('scroll', () => renderList(true));
listScroll.addEventListener('click', (e) => {
  const r = (e.target as HTMLElement).closest('.sp-row') as HTMLElement | null;
  if (!r) return;
  const s = sats[Number(r.dataset.ref)];
  if (!s) return;
  if (multiMode) toggleInSelection(s);
  else setSelection([s]);
  flyToSat(s);
});
listHead.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('span') as HTMLElement | null;
  if (!t) return;
  const k = t.dataset.k as SortKey;
  if (k === sortKey) sortAsc = !sortAsc;
  else {
    sortKey = k;
    sortAsc = true;
  }
  refreshIndexEntries();
});

function flyToSat(s: Sat) {
  if (!s.ok) return;
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(s.lon, s.lat, Math.max(s.altKm * 1000 * 3, 3_000_000)),
    duration: 1.5,
  });
}

// ---------- top readout + details (selected satellite) ----------
const topHud = document.createElement('div');
topHud.className = 'sp-tophud';
topHud.innerHTML = ICONS.axes + '<div><div class="nm"></div><div class="rows"></div></div>';
document.body.appendChild(topHud);
const topHudName = topHud.querySelector('.nm') as HTMLElement;
const topHudRows = topHud.querySelector('.rows') as HTMLElement;

const info = document.createElement('div');
info.className = 'sp-details';
document.body.appendChild(info);

function updateTopHud() {
  if (!primary || !primary.ok) {
    topHud.style.display = 'none';
    return;
  }
  const s = primary;
  topHud.style.display = 'flex';
  topHudName.textContent = s.name;
  topHudRows.innerHTML =
    `<div class="r"><span>Lat</span><b style="font-weight:400">${Math.abs(s.lat).toFixed(4)}° ${s.lat >= 0 ? 'N' : 'S'}</b></div>` +
    `<div class="r"><span>Lon</span><b style="font-weight:400">${Math.abs(s.lon).toFixed(4)}° ${s.lon >= 0 ? 'E' : 'W'}</b></div>` +
    `<div class="r"><span>Alt</span><b style="font-weight:400">${s.altKm.toFixed(1)} km</b></div>`;
}

const passesBox = document.createElement('div');
passesBox.style.cssText =
  'position:absolute;top:56px;right:12px;z-index:5;display:none;' +
  'max-height:55vh;overflow:auto;' + BOX;
document.body.appendChild(passesBox);

// UTC clock (top center)
const clockBox = document.createElement('div');
clockBox.className = 'sp-clock';
document.body.appendChild(clockBox);
function updateClock() {
  const t = new Date().toISOString();
  clockBox.innerHTML = ICONS.clock + `<span>${t.slice(0, 10)}&nbsp;&nbsp;${t.slice(11, 19)} UTC</span>`;
}
updateClock();

// earth rotation card (bottom right)
const rot = document.createElement('div');
rot.className = 'sp-rot';
rot.innerHTML =
  ICONS.globe + '<div><div class="a">Earth Rotation</div><div class="b">15.041°/hr</div></div>';
document.body.appendChild(rot);

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
  renderList(true);
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
  setLabel(orbitBtn, orbitMode === 'selected' ? 'Orbits: Selected' : 'Orbits: All');
  rebuildOrbits();
  refreshIndexEntries();
}

function selectMlSats() {
  const found = sats.filter((s) => mlResults[String(s.satrec.satnum)]);
  if (!found.length) {
    alert('None of the ML-tested satellites are in the loaded catalog.');
    return;
  }
  search.value = '';
  for (const s of sats) s.matches = true;
  refreshIndexEntries();
  setSelection(found);
}

// ---------- panels ----------
function updateHud() {
  statTotal.textContent = sats.length.toLocaleString();
  statShown.textContent = shownCount.toLocaleString();
  hud.innerHTML =
    (selectedSet.size ? `${selectedSet.size} selected` : '') +
    (bulkNote ? `${selectedSet.size ? '<br>' : ''}<span style="font-size:12px;opacity:.85">${bulkNote}</span>` : '');
}

function satBlock(s: Sat): string {
  let h =
    `<b>${esc(s.name)}</b><br>` +
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
  updateTopHud();
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
  updateClock();
  renderList(false);
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
  refreshIndexEntries();
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
    passesBox.textContent = 'Click "My Location" to see passes.';
    return;
  }
  const passes = computePasses(primary);
  passesBox.innerHTML =
    `<b>${esc(primary.name)}</b><br>Next 24 h over you (above 10°):<br>` +
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
    sortedIdx = sats.map((_, i) => i).sort((a, b) => collator.compare(sats[a].name, sats[b].name));
    refreshIndexEntries();
    update();
    refreshIndexEntries();
    setInterval(update, 1000);
  } catch (err) {
    console.error(err);
    hud.textContent = 'Failed to load satellite data (see console)';
  }
}

main();