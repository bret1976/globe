/**
 * Phone-lite caps for the three heaviest data layers (DRAFT, needs Bret's OK).
 *
 * On iPhone-class clients a 14-layer share link plus photoreal tiles can push
 * the Safari tab past its memory budget. These caps apply ONLY when
 * isConstrainedGlobeClient() is true; desktop is untouched. Same styling —
 * phones just draw fewer of the heaviest items:
 *   - local wildfires: the 40K most intense detections (highest FRP)
 *   - ALPR cameras: the 300 nearest the view centre (desktop: 1500)
 *   - datacenters: building footprints drawn as their centre marker only
 */
import { isConstrainedGlobeClient } from './clientCapabilities.js';

export const PHONE_LITE_FIRMS_LIMIT = 40_000;
export const PHONE_LITE_ALPR_MAX_RENDERED = 300;

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
