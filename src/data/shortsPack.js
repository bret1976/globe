/**
 * GodsEye Shorts pack (2026-09-10 → 2026-09-18) — Bret Railway globe.
 *
 * Reimplements ideas from Bilawal Sidhu's free/public Shorts on HIS hosted globe:
 *  1) Bay Area air + marine traffic
 *  2) Digital nervous system (TeleGeography cables + landings + OSM DCs + HUD)
 *  3) Delta / voice cockpit (uses existing cockpit HUD; this pack flies a Delta-style approach)
 *  4) Area 51 TR-3B easter egg (fly Groom Lake + surface TR-3B toggle tip)
 *  5) Nepal floods reconstruction (enables upstream Bhote Koshi scene layers)
 *  6) Traffic & CCTV God's Eye (Austin → London → SF; TomTom / camera layers)
 *
 * Cable geometry: same bilawalsidhu/gods-eye-view bundled TeleGeography public map
 * GeoJSON (CC BY-NC-SA 3.0). Not scraped from submarinecablemap.com in this change.
 */
import * as Cesium from 'cesium';

export const SHORTS_PACK_VERSION = '2026-09-18-traffic-cctv';
export const SHORTS_PARAM = 'shorts';

/** Hash/query values → pack id */
export const SHORTS_ALIASES = Object.freeze({
  bay: 'bay-area',
  'bay-area': 'bay-area',
  sf: 'bay-area',
  nervous: 'nervous',
  cables: 'nervous',
  dns: 'nervous',
  cockpit: 'cockpit',
  delta: 'cockpit',
  voice: 'cockpit',
  a51: 'area51',
  area51: 'area51',
  'area-51': 'area51',
  tr3b: 'area51',
  nepal: 'nepal',
  flood: 'nepal',
  'bhote-koshi': 'nepal',
  traffic: 'traffic',
  cctv: 'traffic',
  streets: 'traffic',
  tomtom: 'traffic',
  spy: 'traffic',
});

const BAY_VIEW = Object.freeze({
  lon: -122.35,
  lat: 37.75,
  height: 85_000,
  heading: 20,
  pitch: -55,
  duration: 2.8,
});

const NERVOUS_VIEW = Object.freeze({
  lon: -32,
  lat: 32,
  height: 9_200_000,
  heading: 10,
  pitch: -85,
  duration: 3.0,
});

const NERVOUS_FRANCE = Object.freeze({
  lon: 2.4,
  lat: 46.6,
  height: 1_200_000,
  heading: 0,
  pitch: -70,
  duration: 2.6,
});

const AREA51_VIEW = Object.freeze({
  lon: -115.8111,
  lat: 37.235,
  height: 18_000,
  heading: 35,
  pitch: -42,
  duration: 3.0,
});

const NEPAL_VIEW = Object.freeze({
  lon: 85.9,
  lat: 27.85,
  height: 55_000,
  heading: 15,
  pitch: -45,
  duration: 3.0,
});

const COCKPIT_SFO = Object.freeze({
  lon: -122.379,
  lat: 37.55,
  height: 4_200,
  heading: 350,
  pitch: -12,
  duration: 2.4,
});

/** Austin Capitol — city-scale God's Eye (locations.js austin capitol). */
const TRAFFIC_AUSTIN = Object.freeze({
  lon: -97.7403,
  lat: 30.2747,
  height: 42_000,
  heading: 165,
  pitch: -52,
  duration: 2.6,
});

/** London Tower Bridge. */
const TRAFFIC_LONDON = Object.freeze({
  lon: -0.0754,
  lat: 51.5055,
  height: 38_000,
  heading: 248,
  pitch: -50,
  duration: 2.8,
});

/** SF Transamerica / downtown. */
const TRAFFIC_SF = Object.freeze({
  lon: -122.4028,
  lat: 37.7952,
  height: 36_000,
  heading: 28,
  pitch: -48,
  duration: 2.6,
});

function flyTo(viewer, shot) {
  if (!viewer?.camera || !Cesium) return Promise.resolve();
  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        shot.lon,
        shot.lat,
        shot.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(shot.heading || 0),
        pitch: Cesium.Math.toRadians(shot.pitch || -45),
        roll: 0,
      },
      duration: reduced ? 0 : shot.duration || 2.5,
      complete: resolve,
      cancel: resolve,
    });
  });
}

function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4200);
}

function ensureBadge() {
  let badge = document.getElementById('shorts-pack-badge');
  if (badge) return badge;
  badge = document.createElement('div');
  badge.id = 'shorts-pack-badge';
  badge.setAttribute('role', 'status');
  badge.style.cssText =
    'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:40;' +
    'padding:6px 12px;border:1px solid rgba(127,255,212,.45);border-radius:999px;' +
    'background:rgba(4,12,18,.78);color:#9fffe0;font:600 11px/1.2 "JetBrains Mono",monospace;' +
    'letter-spacing:.04em;pointer-events:none;backdrop-filter:blur(6px)';
  badge.textContent = `SHORTS PACK · ${SHORTS_PACK_VERSION}`;
  document.body.appendChild(badge);
  return badge;
}

async function enableLayers(dataManager, ids = []) {
  if (!dataManager?.setEnabled) return;
  for (const id of ids) {
    try {
      await dataManager.setEnabled(id, true, { origin: 'user' });
    } catch {
      /* layer may be key-gated or absent */
    }
  }
}

/**
 * Parse shorts pack id from hash or search.
 * @returns {string|null}
 */
export function parseShortsPackFromLocation(loc = window.location) {
  try {
    const hash = String(loc.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const search = new URLSearchParams(String(loc.search || '').replace(/^\?/, ''));
    const raw = params.get(SHORTS_PARAM) || search.get(SHORTS_PARAM);
    if (!raw) return null;
    const key = String(raw).trim().toLowerCase();
    return SHORTS_ALIASES[key] || null;
  } catch {
    return null;
  }
}

/**
 * Run a shorts pack cinematic against the live globe.
 * @param {object} input
 * @param {import('cesium').Viewer} input.viewer
 * @param {object} [input.dataManager]
 */
export async function runShortsPack(input = {}) {
  const { viewer, dataManager } = input;
  const pack = input.pack || parseShortsPackFromLocation();
  if (!pack || !viewer) return null;

  ensureBadge();

  if (pack === 'bay-area') {
    toast('SHORTS · Bay Area air + marine (OpenSky / AIS)');
    await enableLayers(dataManager, [
      'flights',
      'ais-live-vessels',
      'military',
    ]);
    await flyTo(viewer, BAY_VIEW);
    return pack;
  }

  if (pack === 'nervous') {
    toast('SHORTS · Digital nervous system (TeleGeography cables + OSM DCs)');
    await enableLayers(dataManager, [
      'telegeography-submarine-cables',
      'local-datacenters',
      'local-dams',
    ]);
    await flyTo(viewer, NERVOUS_VIEW);
    await flyTo(viewer, NERVOUS_FRANCE);
    return pack;
  }

  if (pack === 'cockpit') {
    toast('SHORTS · Cockpit / voice approach (SFO)');
    await enableLayers(dataManager, ['flights', 'ais-live-vessels']);
    await flyTo(viewer, COCKPIT_SFO);
    document.getElementById('enter-cockpit')?.click?.();
    document.querySelector('[data-view="cockpit"]')?.click?.();
    document.querySelector('[data-mode="cockpit"]')?.click?.();
    return pack;
  }

  if (pack === 'area51') {
    toast('SHORTS · Area 51 · track a contact then 🛸 TR-3B');
    await enableLayers(dataManager, [
      'flights',
      'military',
      'military-installations',
      'military-awareness',
    ]);
    await flyTo(viewer, AREA51_VIEW);
    document.querySelector('[data-easter="tr3b"]')?.click?.();
    document.getElementById('tr3b-toggle')?.click?.();
    return pack;
  }

  if (pack === 'nepal') {
    toast('SHORTS · Nepal floods reconstruction');
    await enableLayers(dataManager, [
      'bhote-koshi-2026',
      'bhote-koshi-locator',
      'earthquakes',
      'local-dams',
    ]);
    await flyTo(viewer, NEPAL_VIEW);
    return pack;
  }

  if (pack === 'traffic') {
    toast('SHORTS · Traffic & CCTV · God\'s Eye (Austin → London → SF)');
    await enableLayers(dataManager, ['traffic', 'cctv']);
    await flyTo(viewer, TRAFFIC_AUSTIN);
    await flyTo(viewer, TRAFFIC_LONDON);
    await flyTo(viewer, TRAFFIC_SF);
    return pack;
  }

  return null;
}

/**
 * Boot hook — call after viewer + dataManager exist.
 * Re-runs when the operator (or a shared link) changes `#shorts=`.
 */
export function initShortsPack(input = {}) {
  const location = input.location;
  const pack = parseShortsPackFromLocation(location);
  let generation = 0;

  const launch = (nextPack) => {
    if (!nextPack || !input.viewer) return Promise.resolve(null);
    const token = ++generation;
    ensureBadge();
    // Share restoration rewrites `#shorts=` into `#v=2&lat=…`. Keep the
    // pack visible to first-run so the welcome launcher cannot steal hops.
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.shortsPack = nextPack;
    }
    return runShortsPack({ ...input, pack: nextPack }).then((result) =>
      token === generation ? result : nextPack,
    );
  };

  const target = input.windowRef || (typeof window !== 'undefined' ? window : null);
  if (target?.addEventListener) {
    target.addEventListener('hashchange', () => {
      const next = parseShortsPackFromLocation(target.location || location);
      return next ? launch(next) : Promise.resolve(null);
    });
  }

  if (!pack) return { pack: null, promise: Promise.resolve(null) };
  return { pack, promise: launch(pack) };
}
