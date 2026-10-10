/**
 * NOAA/NHC forecast cones, tracks and points → normalized storm rows.
 *
 * Data: NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center
 * tropical weather summary GIS (keyless, U.S. Government work, public domain).
 * Layers 5 (forecast points), 6 (forecast track) and 7 (forecast cone) of
 * NHC_tropical_weather_summary/MapServer.
 *
 * Ported in spirit from bilawalsidhu/gods-eye-view v0.2.0 (MIT, © 2026
 * Bilawal Sidhu) `server/providers/cyclones.js`, which first combined these
 * three GIS parts; this normalizer is a smaller original rewrite for
 * GodsEye's layer pattern. The cone shows uncertainty in the forecast centre
 * track — not storm size or a complete hazard boundary.
 */

export const NHC_GIS_URL =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
export const NHC_LAYERS = Object.freeze({ points: 5, track: 6, cone: 7 });

/** Query URL for one NHC GIS layer as GeoJSON in WGS84. */
export function nhcLayerQueryUrl(layerId) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    f: 'geojson',
    outSR: '4326',
    geometryPrecision: '3',
  });
  return `${NHC_GIS_URL}/${layerId}/query?${params}`;
}

const MAX_STORMS = 32;
const MAX_POINTS = 64;
const MAX_RING_POINTS = 4000;

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const text = (value, max = 80) => {
  if (typeof value !== 'string') return '';
  const t = value.replace(/[\u0000-\u001f<>]/g, '').trim();
  return t.length > max ? t.slice(0, max) : t;
};
const validLonLat = (pair) =>
  Array.isArray(pair) &&
  pair.length >= 2 &&
  Number.isFinite(pair[0]) &&
  Number.isFinite(pair[1]) &&
  Math.abs(pair[0]) <= 180 &&
  Math.abs(pair[1]) <= 90;

/** Storm key shared by all three parts (basin + storm number, e.g. EP20). */
export function stormKey(props) {
  const basin = text(props?.basin, 4).toUpperCase();
  const num = finite(props?.stormnum);
  if (!/^(AL|EP|CP)$/.test(basin) || num === null || num < 0 || num > 99)
    return null;
  return `${basin}${String(Math.round(num)).padStart(2, '0')}`;
}

function cleanRing(ring) {
  if (!Array.isArray(ring)) return null;
  const out = [];
  for (const pair of ring) {
    if (!validLonLat(pair)) return null;
    out.push([pair[0], pair[1]]);
    if (out.length > MAX_RING_POINTS) return null;
  }
  return out.length >= 4 ? out : null;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  const list =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const out = [];
  for (const rings of list || []) {
    const outer = cleanRing(rings?.[0]);
    if (outer) out.push(outer);
  }
  return out;
}

function linesOf(geometry) {
  if (!geometry) return [];
  const list =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const out = [];
  for (const line of list || []) {
    if (!Array.isArray(line) || !line.every(validLonLat)) continue;
    if (line.length >= 2 && line.length <= MAX_RING_POINTS)
      out.push(line.map((pair) => [pair[0], pair[1]]));
  }
  return out;
}

/** Saffir–Simpson style label from max wind (kt). */
export function intensityCategory(windKt, stormType = '') {
  const w = finite(windKt);
  const type = String(stormType || '').toUpperCase();
  if (w === null) return type || 'Storm';
  if (w >= 137) return 'Cat 5';
  if (w >= 113) return 'Cat 4';
  if (w >= 96) return 'Cat 3';
  if (w >= 83) return 'Cat 2';
  if (w >= 64) return 'Cat 1';
  if (w >= 34) return type.startsWith('S') ? 'Subtropical storm' : 'Tropical storm';
  if (type === 'PTC') return 'Potential TC';
  return type.startsWith('S') ? 'Subtropical depression' : 'Depression';
}

/**
 * Join the three NHC GIS FeatureCollections into storm rows.
 * Advisory numbers must agree across parts; a mismatched part is dropped
 * rather than drawn against the wrong advisory.
 */
export function normalizeHurricaneCones({ points, track, cone } = {}) {
  const storms = new Map();
  const ensure = (props) => {
    const key = stormKey(props);
    if (!key) return null;
    if (!storms.has(key)) {
      if (storms.size >= MAX_STORMS) return null;
      storms.set(key, {
        stableId: key.toLowerCase(),
        basin: key.slice(0, 2),
        name: '',
        advisory: '',
        advisoryDate: '',
        points: [],
        tracks: [],
        cones: [],
      });
    }
    return storms.get(key);
  };
  const advisoryOf = (props) => text(String(props?.advisnum ?? ''), 8);

  for (const feature of points?.features || []) {
    const p = feature?.properties || {};
    const row = ensure(p);
    if (!row) continue;
    const coords = feature?.geometry?.coordinates;
    const lat = finite(p.lat) ?? (validLonLat(coords) ? coords[1] : null);
    const lon = finite(p.lon) ?? (validLonLat(coords) ? coords[0] : null);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue;
    if (row.points.length >= MAX_POINTS) continue;
    const advisory = advisoryOf(p);
    if (row.advisory && advisory && row.advisory !== advisory) continue;
    row.advisory ||= advisory;
    row.advisoryDate ||= text(p.advdate, 48);
    row.name ||= text(p.stormname, 60);
    row.points.push({
      tau: finite(p.tau) ?? 0,
      lat,
      lon,
      maxWindKt: finite(p.maxwind),
      gustKt: finite(p.gust),
      pressureMb: finite(p.mslp),
      stormType: text(p.stormtype, 8),
      development: text(p.tcdvlp, 40),
      dateLabel: text(p.datelbl, 32),
      timezone: text(p.timezone, 8),
      directionDeg: finite(p.tcdir),
      speedKt: finite(p.tcspd),
    });
  }

  for (const [kind, collection] of [
    ['tracks', track],
    ['cones', cone],
  ]) {
    for (const feature of collection?.features || []) {
      const p = feature?.properties || {};
      const row = ensure(p);
      if (!row) continue;
      const advisory = advisoryOf(p);
      if (row.advisory && advisory && row.advisory !== advisory) continue;
      row.advisory ||= advisory;
      row.advisoryDate ||= text(p.advdate, 48);
      if (!row.name) row.name = text(p.stormname, 60);
      const parts =
        kind === 'cones'
          ? polygonsOf(feature.geometry)
          : linesOf(feature.geometry);
      row[kind].push(...parts);
    }
  }

  const rows = [];
  for (const row of storms.values()) {
    row.points.sort((a, b) => a.tau - b.tau);
    if (!row.points.length && !row.cones.length && !row.tracks.length) continue;
    const current = row.points[0] || null;
    const anchor = current
      ? { lat: current.lat, lon: current.lon }
      : row.tracks[0]
        ? { lon: row.tracks[0][0][0], lat: row.tracks[0][0][1] }
        : { lon: row.cones[0][0][0], lat: row.cones[0][0][1] };
    const peak = row.points.reduce(
      (best, point) =>
        Number.isFinite(point.maxWindKt) &&
        (!best || point.maxWindKt > best.maxWindKt)
          ? point
          : best,
      null,
    );
    rows.push({
      ...row,
      name: row.name || row.stableId.toUpperCase(),
      anchor,
      current,
      peakWindKt: peak?.maxWindKt ?? null,
      category: intensityCategory(current?.maxWindKt, current?.stormType),
    });
  }
  rows.sort((a, b) => (b.current?.maxWindKt ?? 0) - (a.current?.maxWindKt ?? 0));
  return rows;
}
