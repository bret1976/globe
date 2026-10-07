/**
 * NOAA SWPC GloTEC — global ionospheric Total Electron Content (TEC).
 * Normalizes the 10-minute GeoJSON grid (5° lon × 2.5° lat) into compact rows.
 *
 * U.S. Government work (public domain). Keyless.
 */

export const GLOTEC_ORIGIN = 'https://services.swpc.noaa.gov';
export const GLOTEC_INDEX_URL = `${GLOTEC_ORIGIN}/products/glotec/geojson_2d_urt.json`;
const GLOTEC_PATH_RE = /^\/products\/glotec\/geojson_2d_urt\/[A-Za-z0-9_.-]+\.geojson$/;

/** Pick the newest frame from the SWPC index; host- and path-pinned. */
export function latestGlotecFrame(index) {
  if (!Array.isArray(index)) return null;
  let best = null;
  let bestT = -Infinity;
  for (const entry of index) {
    const url = typeof entry?.url === 'string' ? entry.url : '';
    if (!GLOTEC_PATH_RE.test(url)) continue;
    const t = Date.parse(entry?.time_tag);
    if (!Number.isFinite(t) || t <= bestT) continue;
    best = { url: `${GLOTEC_ORIGIN}${url}`, timeTag: new Date(t).toISOString() };
    bestT = t;
  }
  return best;
}

function num(value) {
  return value === null || value === undefined || value === '' ? NaN : Number(value);
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Normalize the GloTEC FeatureCollection → { timeTag, rows }. */
export function normalizeGlotec(body) {
  const features = Array.isArray(body?.features) ? body.features : [];
  const rows = [];
  for (const feature of features) {
    const c = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
    if (!Array.isArray(c)) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const p = feature.properties || {};
    if (p.tec === null || p.tec === undefined || p.tec === '') continue;
    const tec = Number(p.tec);
    if (!Number.isFinite(tec) || tec < 0 || tec > 300) continue;
    const anomaly = num(p.anomaly);
    const hmF2 = num(p.hmF2);
    const nmF2 = num(p.NmF2);
    rows.push({
      stableId: `${round(lat, 2)}:${round(lon, 2)}`,
      lat: round(lat, 2),
      lon: round(lon, 2),
      tec: round(tec, 1),
      anomaly: Number.isFinite(anomaly) ? round(anomaly, 2) : null,
      hmF2: Number.isFinite(hmF2) ? Math.round(hmF2) : null,
      nmF2: Number.isFinite(nmF2) && nmF2 > 0 ? Number(nmF2.toPrecision(3)) : null,
      quality: Number.isFinite(num(p.quality_flag)) ? num(p.quality_flag) : null,
    });
  }
  const timeTag = Number.isFinite(Date.parse(body?.time_tag))
    ? new Date(Date.parse(body.time_tag)).toISOString()
    : null;
  return { timeTag, rows };
}

/** Summary stats for the payload. */
export function glotecStats(rows) {
  if (!rows.length) return { minTec: null, maxTec: null, medianTec: null };
  const values = rows.map((r) => r.tec).sort((a, b) => a - b);
  return {
    minTec: values[0],
    maxTec: values[values.length - 1],
    medianTec: values[Math.floor(values.length / 2)],
  };
}

// TECU color ramp: deep blue (quiet night side) → cyan → green → yellow → red.
const RAMP = Object.freeze([
  [0, [20, 30, 110]],
  [8, [40, 90, 220]],
  [16, [0, 190, 230]],
  [28, [40, 210, 90]],
  [42, [250, 220, 40]],
  [60, [255, 130, 20]],
  [85, [230, 30, 50]],
]);

export function tecColorCss(tec) {
  const v = Number(tec);
  if (!Number.isFinite(v)) return 'rgb(128,128,128)';
  if (v <= RAMP[0][0]) return `rgb(${RAMP[0][1].join(',')})`;
  for (let i = 1; i < RAMP.length; i += 1) {
    const [t1, c1] = RAMP[i];
    if (v <= t1) {
      const [t0, c0] = RAMP[i - 1];
      const f = (v - t0) / (t1 - t0);
      const c = c0.map((x, k) => Math.round(x + (c1[k] - x) * f));
      return `rgb(${c.join(',')})`;
    }
  }
  return `rgb(${RAMP[RAMP.length - 1][1].join(',')})`;
}

export function tecPixelSize(tec) {
  const v = Math.max(0, Number(tec) || 0);
  return Math.round(Math.min(14, 5 + v / 8) * 10) / 10;
}
