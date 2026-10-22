# ORBIT: Real-Time Satellite Tracker with ML-Corrected Orbit Prediction

A web app that shows about 16,000 active satellites moving around a 3D Earth in real time. Click a satellite to see its altitude and speed, draw its orbit, predict when it passes over you, and compare plain SGP4 predictions with a machine-learning correction I trained.

> See [Limitations](#limitations) before relying on any number in this README.

<!-- Add screenshots here, e.g. ![Desktop view](docs/desktop.png) ![Phone view](docs/phone.png) -->

## What it does

- **Live globe:** about 16,000 satellites from the CelesTrak "active" list, positions recomputed every second in the browser.
- **Search:** filter by name or NORAD ID.
- **Click to inspect:** name, NORAD ID, altitude, speed, latitude/longitude, inclination.
- **Multi-select:** pick several satellites and view them together.
- **Orbits:** an orbit ring and a ground track for each selected satellite. On desktop there is also an "all matching" mode (capped at 300 satellites).
- **Satellite index:** a scrollable A-Z list of all satellites that follows the search box.
- **Pass prediction (desktop):** press "Use my location" and see when the selected satellite is above 10° elevation in the next 24 hours.
- **ML panel:** for satellites I trained a model on, a chart of SGP4 error vs SGP4 + ML error by forecast horizon.
- **Two renderers:** CesiumJS on desktop, three-globe on touch screens (see [Why two renderers](#why-two-renderers)).

## How it works

1. Orbit data (TLEs) comes from [CelesTrak](https://celestrak.org). A snapshot is stored in `public/active.tle` so the app runs without hitting CelesTrak's rate limit.
2. [satellite.js](https://github.com/shashwatak/satellite-js) runs the SGP4 propagator to turn each TLE into a position for the current time.
3. The renderer draws the positions: CesiumJS point primitives on desktop, a single `THREE.Points` object on phones.
4. Orbit rings are one orbital period of positions; ground tracks are the same positions projected onto the surface.

## The machine learning part

**Question:** can a small ML model reduce SGP4's prediction error over the next 1-3 days?

**Data:** historical TLEs from the Hugging Face dataset [`juliensimon/space-track-tle-history`](https://huggingface.co/datasets/juliensimon/space-track-tle-history) (sourced from Space-Track). Check the dataset's license and Space-Track's terms before reusing or redistributing the data.

**Method**

- Pick satellites with smooth orbits (no large step changes in mean motion), found by scanning the 2024 data.
- Rebuild each TLE as an SGP4 satellite in Python (`sgp4` package).
- For every pair of TLEs up to 72 hours apart, propagate the older TLE to the newer TLE's epoch and measure the difference (radial / along-track / cross-track).
- Train one gradient-boosting model (scikit-learn `HistGradientBoostingRegressor`, absolute-error loss) per direction to predict that difference. Features: forecast horizon, how unusual the B* drag term is compared with recent TLEs, deviation of mean motion from its recent median, and the gap since the previous TLE.
- **Hybrid:** use plain SGP4 for horizons up to 24 hours, and SGP4 + ML correction beyond that. The 24-hour cutoff was chosen before looking at the test results.
- **Split:** train on 2024, test on 2025. Satellite choice and feature design used 2024 data only.

**Results (median position error, km, tested on 2025)**

| Satellite (NORAD) | Horizon | SGP4 | SGP4 + ML (hybrid) | Change |
|---|---|---|---|---|
| 57166 | 24-36 h | 0.0815 | 0.0457 | about -44% |
| 57166 | 48-72 h | 0.1530 | 0.0837 | about -45% |
| 57490 | 24-36 h | 0.0866 | 0.0488 | about -44% |
| 57490 | 48-72 h | 0.1737 | 0.0959 | about -45% |

Overall median error fell by about 43% (57166) and 45% (57490). Under 24 hours the hybrid uses plain SGP4 because the model was slightly worse there. Results for the other satellites in `public/ml_results.json` come from the same notebook and may differ; some may show little or no improvement.

The app does **not** run the model live. It displays these precomputed results from `public/ml_results.json`.

## Limitations

- **The "truth" is the next official TLE, not the real position.** An improvement means "closer to the next TLE", which has its own error.
- **Few satellites, hand-picked.** The satellites were chosen for smooth orbits. The results say nothing about satellites that maneuver, and I have not shown the model transfers between satellites; each one is trained separately.
- **Small absolute gains.** At 48-72 h the improvement is tens of meters. It is a solid relative improvement, not something visible on the globe.
- **Nearby test pairs share TLEs,** so the effective sample size is smaller than the pair counts. No significance tests were run.
- **SGP4 accuracy depends on TLE age.** `public/active.tle` is a snapshot and goes stale; positions and passes get less accurate over time.
- **Pass prediction means "above the horizon", not "visible to the eye".** It does not check darkness or sunlight.


## Why two renderers

On some Android Chrome versions, Cesium's globe imagery disappears when zooming out (the globe turns black). The same problem was reported to the Cesium team ([CesiumGS/cesium#12936](https://github.com/CesiumGS/cesium/issues/12936)) and reproduced on a phone I tested, including in Cesium's own Sandcastle. Rather than depend on it, touch screens use a second renderer built with [three-globe](https://github.com/vasturiano/three-globe). Data loading, physics, the ML panel and the index are shared.

- Touch screens (`pointer: coarse` and width under 900 px) load `src/mobile.ts`.
- Everything else loads `src/desktop.ts`.
- Force one with `?mode=mobile` or `?mode=desktop` in the URL.

## Getting started

**Requirements:** Node.js 20.19+ or 22.12+ (Vite requirement).

```bash
git clone https://github.com/YOUR_USERNAME/sat-globe.git
cd sat-globe
npm install
```

Create a free [Cesium ion](https://cesium.com/ion/) access token and put it in a file named `.env` in the project root (this file is git-ignored; never commit it):

```
VITE_CESIUM_TOKEN=your_token_here
```

Run it:

```bash
npm run dev
```

Open the `Local:` address that Vite prints. Add `?mode=mobile` to preview the phone version on your computer.

**To test on a phone on the same Wi-Fi:**

```bash
npm run dev -- --host
```

Then open the `Network:` address on the phone.

**The mobile renderer needs an Earth image** at `public/earth.jpg`. If it is missing:

```bash
npm install three three-globe
npm install -D @types/three
copy node_modules\three-globe\example\img\earth-blue-marble.jpg public\earth.jpg
```

(Use `cp` instead of `copy` on macOS/Linux.)

### Android app (Capacitor)

The web build can be wrapped as an Android app with [Capacitor](https://capacitorjs.com). Requires Android Studio.

```bash
npm run build
npx cap sync
npx cap open android
```

Run it from Android Studio on a connected phone. After any code change, run `npm run build && npx cap sync` again. Android only: iOS needs macOS and Xcode.

Note: the Cesium token is baked into the built app, so do not distribute the APK publicly.

## Project structure

```
src/
  main.ts        picks desktop or mobile renderer
  desktop.ts     CesiumJS version (full feature set)
  mobile.ts      three-globe version for touch screens
  satIndex.ts    virtualized A-Z satellite list (shared)
public/
  active.tle         snapshot of CelesTrak active satellites (goes stale)
  ml_results.json    precomputed SGP4 vs ML error per satellite
  earth.jpg          Earth texture for the mobile renderer
notebooks/           the ML notebook (add your exported .ipynb here)
```

## Tech stack

TypeScript, Vite, CesiumJS, three.js + three-globe, satellite.js, Capacitor. ML in Python: `sgp4`, DuckDB, pandas, scikit-learn.

## Data and credits

- Orbit data: [CelesTrak](https://celestrak.org) (note: it rate-limits repeated downloads).
- Historical TLEs: Hugging Face dataset `juliensimon/space-track-tle-history`, derived from Space-Track.
- Earth texture: the Blue Marble image shipped in three-globe's examples. Check its license before redistributing.
- Libraries: CesiumJS, three.js, three-globe, satellite.js, Capacitor.

## License

TODO: add a license (for example MIT) before sharing publicly.
