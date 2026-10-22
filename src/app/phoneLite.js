/**
 * Phone-lite caps for the three heaviest data layers (DRAFT, needs Bret's OK).
 *
 * On iPhone-class clients a 14-layer share link plus photoreal tiles can push
 * the Safari tab past its memory budget. These caps apply ONLY when
 * isConstrainedGlobeClient() is true; desktop is untouched. Same styling —
 * phones just draw fewer of the heaviest items:
 *   - local wildfires: the 15K most intense detections (highest FRP)
 *   - ALPR cameras: the 300 nearest the view centre (desktop: 1500)
 *   - datacenters: building footprints drawn as their centre marker only
 *   - AIS vessels: 3000 rows / 150 labels (desktop 12000 / 900)
 */
import { isConstrainedGlobeClient } from './clientCapabilities.js';

// 40K detections was a ~7.9 MB JSON per refresh on phones; 15K keeps every
// significant fire (sorted by FRP) at ~3 MB.
export const PHONE_LITE_FIRMS_LIMIT = 15_000;
/** AIS vessels on phones (desktop default 12000; live feed is ~31K rows / 7 MB). */
export const PHONE_LITE_VESSEL_ROWS = 3000;
/**
 * Layers fully destroyed on toggle-off on phones (re-init verified in mobile
 * emulation). Excludes modules whose destroy() is terminal: local GeoJSON
 * datasets, FIRMS, weather, nowCOAST, recent imagery, ALPR.
 */
export const PHONE_LITE_RELEASE_ON_DISABLE = Object.freeze([
  'flights',
  'ais-live-vessels',
  'satellites',
  'cctv',
  'military',
  'fire-perimeters',
  'rocket-launches',
  'gps-interference',
]);
/** Data layers allowed on at once on phones; enabling one more turns off the oldest. */
export const PHONE_LITE_MAX_ACTIVE_LAYERS = 4;
/** Manager-owned feed refresh intervals are multiplied by this on phones. */
export const PHONE_LITE_FEED_INTERVAL_SCALE = 2;
/** Vessel name labels on phones (desktop 900). */
export const PHONE_LITE_VESSEL_LABELS = 150;
export const PHONE_LITE_ALPR_MAX_RENDERED = 300;
/** CCTV camera icons drawn on phones: the nearest to the camera eye. */
export const PHONE_LITE_CCTV_MAX_RENDERED = 300;
/** Flight text labels on phones: only the nearest contacts carry one. */
export const PHONE_LITE_FLIGHT_LABELS = 15;

let cached = null;
/** @returns {boolean} */
export function isPhoneLite(detect = isConstrainedGlobeClient) {
  if (detect !== isConstrainedGlobeClient) return Boolean(detect());
  if (cached === null) {
    try {
      cached = Boolean(detect());
    } catch {
      cached = false;
    }
  }
  return cached;
}

/** Polygon/MultiPolygon → Point at its first ring's vertex average. */
export function footprintToPoint(feature) {
  const g = feature?.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return feature;
  const ring = g.type === 'Polygon' ? g.coordinates?.[0] : g.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || !ring.length) return feature;
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  let lon = 0;
  let lat = 0;
  for (const p of pts) {
    lon += Number(p[0]);
    lat += Number(p[1]);
  }
  return { ...feature, geometry: { type: 'Point', coordinates: [lon / pts.length, lat / pts.length] } };
}
