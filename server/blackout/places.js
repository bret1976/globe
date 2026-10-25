/**
 * Coarse "near <sea/region>" naming for Blackout events, and the watch areas
 * people can filter email alerts by. Boxes are [west, south, east, north] in
 * degrees and deliberately rough: the text says "near", never "in". Smaller
 * boxes are listed first so the most specific name wins.
 */
import fs from 'node:fs';
import { JAM_REGIONS } from '../../src/watch/model.js';

let landRings = null;
/** Natural Earth 1:110m land (public domain), the same file the page draws. */
function land() {
  if (landRings) return landRings;
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('../../public/watch/land-110m.json', import.meta.url), 'utf8'));
    landRings = (raw.rings || []).map((ring) => {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
      return { ring, box: [w, s, e, n] };
    });
  } catch { landRings = []; }
  return landRings;
}

function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is on land at 1:110m (coastal points may go either way). */
export function onLand(lat, lon) {
  for (const r of land()) if (inBox(lat, lon, r.box) && inRing(lat, lon, r.ring)) return true;
  return false;
}

const deg = (v, pos, neg) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;

export const PLACES = Object.freeze([
  ['Strait of Hormuz', [54, 25, 58, 27.5]],
  ['Bab-el-Mandeb', [42, 11.5, 44.5, 13.5]],
  ['Bosphorus', [28.5, 40.8, 29.5, 41.4]],
  ['Strait of Gibraltar', [-6.5, 35.6, -4.8, 36.3]],
  ['Taiwan Strait', [117.5, 22, 121, 26]],
  ['Strait of Malacca', [95, 1, 104, 6.5]],
  ['Singapore Strait', [103.4, 1, 104.5, 1.5]],
  ['Kerch Strait', [36.2, 44.9, 36.8, 45.5]],
  ['Gulf of Finland', [22, 59, 30.5, 61]],
  ['English Channel', [-5.8, 48.5, 2, 51.2]],
  ['Suez Canal', [32, 29.8, 32.7, 31.4]],
  ['Persian Gulf', [47.5, 23.5, 56.5, 30.5]],
  ['Gulf of Oman', [56.5, 22, 61.5, 26]],
  ['Gulf of Aden', [43, 10.5, 51.5, 15]],
  ['Red Sea', [32, 12.5, 43.5, 30]],
  ['Sea of Azov', [34.8, 45.2, 39.5, 47.3]],
  ['Black Sea', [27.3, 40.8, 42, 46.8]],
  ['Caspian Sea', [46.5, 36.5, 55, 47.2]],
  ['Aegean Sea', [22.5, 35, 28.5, 41]],
  ['Adriatic Sea', [12, 40, 20, 45.8]],
  ['Eastern Mediterranean', [26, 30, 36.5, 37.5]],
  ['Mediterranean Sea', [-6, 30, 36.5, 46]],
  ['Baltic Sea', [9.5, 53.5, 30.5, 66]],
  ['North Sea', [-4, 51, 9.5, 61.5]],
  ['Norwegian Sea', [-5, 61.5, 20, 72]],
  ['Barents Sea', [20, 68, 60, 80]],
  ['Bay of Biscay', [-10, 43.3, -1, 48.5]],
  ['Irish Sea', [-6.5, 51.5, -2.8, 55]],
  ['Gulf of Mexico', [-98, 18, -80.5, 31]],
  ['Caribbean Sea', [-89, 9, -60, 22]],
  ['Gulf of Guinea', [-5, -5, 12, 6.5]],
  ['Arabian Sea', [51, 5, 77, 25]],
  ['Bay of Bengal', [79, 5, 95, 23]],
  ['Andaman Sea', [92, 5, 99, 17]],
  ['South China Sea', [99, 0, 121, 23]],
  ['East China Sea', [117, 23, 131, 33.5]],
  ['Yellow Sea', [117.5, 33.5, 126.8, 41]],
  ['Sea of Japan', [127, 33.5, 142, 52]],
  ['Sea of Okhotsk', [135, 43, 163, 62]],
  ['Bering Sea', [-180, 51, -157, 66.5]],
  ['Java Sea', [105, -8, 119, -2.5]],
  ['Philippine Sea', [121, 5, 145, 33]],
  ['Coral Sea', [142, -30, 165, -9]],
  ['Tasman Sea', [147, -47, 175, -30]],
  ['Gulf of St. Lawrence', [-70, 45.5, -56, 52]],
  ['Hudson Bay', [-95, 51, -76, 66]],
]);

/** Areas offered as email-alert filters (the six jamming watch boxes plus key chokepoints). */
export const ALERT_AREAS = Object.freeze([
  ...JAM_REGIONS.map((r) => ({ id: r.id, name: r.name, box: r.box })),
  { id: 'red-sea', name: 'Red Sea / Gulf of Aden', box: [32, 10.5, 51.5, 30] },
  { id: 'hormuz', name: 'Strait of Hormuz / Gulf of Oman', box: [54, 22, 61.5, 27.5] },
  { id: 'south-china-sea', name: 'South China Sea', box: [99, 0, 121, 23] },
  { id: 'taiwan', name: 'Taiwan Strait', box: [117.5, 21, 123, 27] },
  { id: 'north-sea', name: 'North Sea / Channel', box: [-6, 48.5, 9.5, 61.5] },
  { id: 'mediterranean', name: 'Mediterranean', box: [-6, 30, 36.5, 46] },
]);

const inBox = (lat, lon, [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n;

function oceanName(lat, lon) {
  if (lat <= -60) return 'Southern Ocean';
  if (lat >= 66) return 'Arctic Ocean';
  const ns = lat >= 0 ? 'North' : 'South';
  if (lon >= -70 && lon <= 20) return `${ns} Atlantic`;
  if (lon > 20 && lon < 147 && lat < 25) return 'Indian Ocean';
  return `${ns} Pacific`;
}

/** "Black Sea" / "North Atlantic"; null for unusable coordinates. */
export function placeName(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const [name, box] of PLACES) if (inBox(lat, lon, box)) return name;
  if (onLand(lat, lon)) return `land at ${deg(lat, 'N', 'S')} ${deg(lon, 'E', 'W')}`;
  return oceanName(lat, lon);
}

/** Alert-area ids whose box contains the point. */
export function areasAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return ALERT_AREAS.filter((a) => inBox(lat, lon, a.box)).map((a) => a.id);
}
