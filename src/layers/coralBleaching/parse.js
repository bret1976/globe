/**
 * NOAA Coral Reef Watch — Daily 5km Regional Virtual Stations.
 *
 * Normalizes the keyless CRW `vs_polygons.json` GeoJSON (one Point + one
 * Polygon/MultiPolygon per station, ~214 reef regions worldwide) into compact
 * station rows: centroid, simplified region outline, current bleaching alert
 * level, SST, SST anomaly, HotSpot, Degree Heating Weeks and the 7-day trend
 * encoded in CRW's gauge filename.
 *
 * U.S. Government work (public domain). Original Bret/GodsEye code.
 */

export const CRW_VS_URL =
  'https://coralreefwatch.noaa.gov/product/vs/vs_polygons.json';

/** Outline vertices kept per ring. */
export const MAX_CORAL_RING_POINTS = 64;
/** Outline parts kept per station (largest first; island groups ship many). */
export const MAX_CORAL_PARTS = 6;
/** Hard cap on stations served to the globe. */
export const MAX_CORAL_STATIONS = 400;

/**
 * Heritage CRW Regional Virtual Station alert scale (still used by the RVS
 * product): 0 No Stress, 1 Bleaching Watch, 2 Bleaching Warning,
 * 3 Alert Level 1, 4 Alert Level 2.
 */
const LEVELS = Object.freeze([
  { name: 'No Stress', short: 'NO STRESS', color: '#7fd3ff' },
  { name: 'Bleaching Watch', short: 'WATCH', color: '#ffee58' },
  { name: 'Bleaching Warning', short: 'WARNING', color: '#ffa726' },
  { name: 'Alert Level 1', short: 'ALERT 1', color: '#ff3b3b' },
  { name: 'Alert Level 2', short: 'ALERT 2', color: '#a3001b' },
]);

export function coralAlertLevel(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(LEVELS.length - 1, n));
}

export function coralAlertName(level) {
  return LEVELS[level]?.name || 'Unknown';
}

export function coralAlertShort(level) {
  return LEVELS[level]?.short || '?';
}

export function coralAlertColorCss(level) {
  return LEVELS[level]?.color || '#9e9e9e';
}

function num(value, digits = 2) {
  const n = Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * Parse CRW's gauge filename `Coral_Bleaching_Alert_Level_<prev>_to_<now>.bmp`
 * into { from, to, trend } where trend ∈ rising | falling | steady.
 */
export function parseCoralGauge(gauge) {
  const m = /Level_(\d)_to_(\d)/i.exec(String(gauge || ''));
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return {
    from,
    to,
    trend: to > from ? 'rising' : to < from ? 'falling' : 'steady',
  };
}

/** Finite [lon,lat] ring, closing point dropped, evenly decimated. */
export function simplifyCoralRing(ring, maxPoints = MAX_CORAL_RING_POINTS) {
  if (!Array.isArray(ring)) return [];
  const pts = [];
  let prevLon = null;
  for (const p of ring) {
    if (!Array.isArray(p)) continue;
    let lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) continue;
    if (prevLon != null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([round4(lon), round4(lat)]);
  }
  if (pts.length > 1) {
    const [a0, a1] = pts[0];
    const [b0, b1] = pts[pts.length - 1];
    if (a0 === b0 && a1 === b1) pts.pop();
  }
  if (pts.length < 3) return [];
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) out.push(pts[Math.floor(i * step)]);
  return out;
}

/** Shoelace area in degrees² (only used to rank parts). */
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Outer rings of a Polygon / MultiPolygon, largest first, capped. */
export function coralOutlineRings(geometry, maxParts = MAX_CORAL_PARTS) {
  if (!geometry || typeof geometry !== 'object') return [];
  let polys = [];
  if (geometry.type === 'Polygon') polys = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polys = geometry.coordinates;
  else return [];
  if (!Array.isArray(polys)) return [];
  const rings = [];
  for (const poly of polys) {
    if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
    const ring = simplifyCoralRing(poly[0]);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings
    .map((ring) => ({ ring, area: ringArea(ring) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, maxParts)
    .map(({ ring }) => ring);
}

function ringCentroid(ring) {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

function wrapLon(lon) {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return round4(x);
}

/**
 * Merge CRW features into one row per station (keyed by name): the Point
 * gives the marker, the (Multi)Polygon gives the outline, properties repeat
 * on both. Sorted most severe first, then by DHW.
 */
export function normalizeCoralStations(
  geojson,
  { limit = MAX_CORAL_STATIONS } = {},
) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const feature of features) {
    const props = feature?.properties;
    const name = String(props?.name || '').trim();
    if (!name) continue;
    const level = coralAlertLevel(props.alert);
    if (level == null) continue;
    let row = byName.get(name);
    if (!row) {
      const gauge = parseCoralGauge(props.gauge);
      row = {
        stableId: name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
        name,
        date: String(props.date || '').trim() || null,
        level,
        levelName: coralAlertName(level),
        sst: num(props.sst),
        ssta: num(props.ssta),
        hotspot: num(props.hs),
        dhw: num(props.dhw),
        prevLevel: gauge ? gauge.from : null,
        trend: gauge ? gauge.trend : null,
        page: props.gauge_page
          ? `https://coralreefwatch.noaa.gov/product/vs/gauges/${String(props.gauge_page).replace(/[^A-Za-z0-9_.-]/g, '')}`
          : null,
        lat: null,
        lon: null,
        rings: [],
      };
      byName.set(name, row);
    }
    const geometry = feature.geometry;
    if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates)) {
      const lon = Number(geometry.coordinates[0]);
      const lat = Number(geometry.coordinates[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90) {
        row.lon = wrapLon(lon);
        row.lat = round4(lat);
      }
    } else if (!row.rings.length) {
      row.rings = coralOutlineRings(geometry);
    }
  }
  const rows = [];
  for (const row of byName.values()) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) {
      if (!row.rings.length) continue;
      const [lon, lat] = ringCentroid(row.rings[0]);
      row.lon = wrapLon(lon);
      row.lat = round4(lat);
    }
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      b.level - a.level ||
      (b.dhw ?? -1) - (a.dhw ?? -1) ||
      a.name.localeCompare(b.name),
  );
  return rows.slice(0, Math.max(0, limit));
}

/** { '0': n, '1': n, ... } histogram of alert levels. */
export function countCoralLevels(rows) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row.level);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Fallback when the CRW station host is offline: the same CRW v3.1 daily
 * 5km product served by PacIOOS ERDDAP (University of Hawaiʻi; keyless,
 * CORS-enabled, public domain NOAA data), sampled every 1° across the reef
 * belt (35°N–35°S). Cells at Bleaching Watch or above become rows.
 */
export const CRW_ERDDAP_BASE =
  'https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km';
const ERDDAP_SLICE =
  '%5B(last)%5D%5B(35):20:(-35)%5D%5B(-179.975):20:(179.975)%5D';
export const CRW_ERDDAP_URL = `${CRW_ERDDAP_BASE}.csv?${[
  'CRW_BAA',
  'CRW_DHW',
  'CRW_SST',
  'CRW_SSTANOMALY',
  'CRW_HOTSPOT',
]
  .map((v) => v + ERDDAP_SLICE)
  .join(',')}`;
export const CRW_ERDDAP_ATTRIBUTION =
  'Coral bleaching heat stress: NOAA Coral Reef Watch Daily 5km v3.1 via PacIOOS ERDDAP (gridded fallback while coralreefwatch.noaa.gov is unreachable)';

function fmtDeg(v, pos, neg) {
  return `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
}

/** ERDDAP griddap CSV (header + units rows) → coral rows, most severe first. */
export function normalizeCoralErddapCsv(
  text,
  { limit = MAX_CORAL_STATIONS, minLevel = 1 } = {},
) {
  const lines = String(text || '').split(/\r?\n/);
  const header = (lines[0] || '').split(',');
  const col = (name) => header.indexOf(name);
  const iT = col('time');
  const iLat = col('latitude');
  const iLon = col('longitude');
  const iBaa = col('CRW_BAA');
  const iDhw = col('CRW_DHW');
  const iSst = col('CRW_SST');
  const iSsta = col('CRW_SSTANOMALY');
  const iHs = col('CRW_HOTSPOT');
  if (iLat < 0 || iLon < 0 || iBaa < 0) return [];
  const rows = [];
  for (let i = 2; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    if (c.length < header.length) continue;
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    const level = coralAlertLevel(c[iBaa]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || level == null)
      continue;
    if (level < minLevel) continue;
    const name = `Reef-belt cell ${fmtDeg(lat, 'N', 'S')} ${fmtDeg(lon, 'E', 'W')}`;
    rows.push({
      stableId: `crw-cell-${round4(lat)}_${round4(lon)}`.replace(
        /[^a-z0-9_.-]/gi,
        '-',
      ),
      name,
      date: iT >= 0 ? String(c[iT]).slice(0, 10) : null,
      level,
      levelName: coralAlertName(level),
      sst: num(c[iSst]),
      ssta: num(c[iSsta]),
      hotspot: num(c[iHs]),
      dhw: num(c[iDhw]),
      prevLevel: null,
      trend: null,
      page: 'https://coralreefwatch.noaa.gov/product/5km/index.php',
      lat: round4(lat),
      lon: wrapLon(lon),
      rings: [],
    });
  }
  rows.sort(
    (a, b) =>
      b.level - a.level ||
      (b.dhw ?? -1) - (a.dhw ?? -1) ||
      a.name.localeCompare(b.name),
  );
  return rows.slice(0, Math.max(0, limit));
}

/** Snapshot payload shared by the proxy and the browser-direct fallback. */
export function coralErddapPayload(text, now = Date.now()) {
  const rows = normalizeCoralErddapCsv(text);
  const dates = rows
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  return {
    fetchedAt: now,
    source: 'NOAA Coral Reef Watch (PacIOOS ERDDAP)',
    attribution: CRW_ERDDAP_ATTRIBUTION,
    license: 'U.S. Government work (public domain)',
    note: 'Gridded fallback: 1° samples of CRW Bleaching Alert Area, Watch level or higher, most severe 400. Satellite heat-stress outlook, not field-confirmed bleaching.',
    fallback: 'erddap',
    date: dates.length ? dates[dates.length - 1] : null,
    rawCount: rows.length,
    count: rows.length,
    levels: countCoralLevels(rows),
    rows,
  };
}

/**
 * Second mirror for the server: NOAA PIFSC OceanWatch ERDDAP serves the same
 * CRW 5km fields as separate datasets (longitude 0–360, no browser CORS).
 */
const OW_BASE = 'https://oceanwatch.pifsc.noaa.gov/erddap/griddap';
const OW_SLICE = '%5B(last)%5D%5B(35):20:(-35)%5D%5B(0.025):20:(359.975)%5D';
export const CRW_OCEANWATCH_URLS = Object.freeze([
  `${OW_BASE}/CRW_baa_max_7d_v1_0.csv?bleaching_alert_area${OW_SLICE}`,
  `${OW_BASE}/CRW_dhw_v1_0.csv?degree_heating_week${OW_SLICE}`,
  `${OW_BASE}/CRW_hs_v1_0.csv?hotspot${OW_SLICE}`,
  `${OW_BASE}/CRW_sst_anom_v1_0.csv?sea_surface_temperature_anomaly${OW_SLICE}`,
]);
const COLUMN_ALIASES = {
  bleaching_alert_area: 'CRW_BAA',
  degree_heating_week: 'CRW_DHW',
  hotspot: 'CRW_HOTSPOT',
  sea_surface_temperature_anomaly: 'CRW_SSTANOMALY',
  analysed_sst: 'CRW_SST',
};
const STD_COLUMNS = [
  'CRW_BAA',
  'CRW_DHW',
  'CRW_SST',
  'CRW_SSTANOMALY',
  'CRW_HOTSPOT',
];

/** Join single-variable ERDDAP CSVs on (lat, lon) into the standard CSV. */
export function mergeCoralErddapCsvs(texts) {
  /** @type {Map<string, any>} */
  const cells = new Map();
  for (const text of texts || []) {
    const lines = String(text || '').split(/\r?\n/);
    const header = (lines[0] || '').split(',');
    const iT = header.indexOf('time');
    const iLat = header.indexOf('latitude');
    const iLon = header.indexOf('longitude');
    const vars = header
      .map((name, i) => [COLUMN_ALIASES[name] || name, i])
      .filter(([name]) => STD_COLUMNS.includes(name));
    if (iLat < 0 || iLon < 0 || !vars.length) continue;
    for (let i = 2; i < lines.length; i += 1) {
      const c = lines[i].split(',');
      if (c.length < header.length) continue;
      let lon = Number(c[iLon]);
      const lat = Number(c[iLat]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lon > 180) lon -= 360;
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { time: iT >= 0 ? c[iT] : '', lat, lon };
        cells.set(key, cell);
      }
      for (const [name, idx] of vars) cell[name] = c[idx];
    }
  }
  const out = [
    ['time', 'latitude', 'longitude', ...STD_COLUMNS].join(','),
    'units',
  ];
  for (const cell of cells.values()) {
    out.push(
      [
        cell.time,
        cell.lat,
        cell.lon,
        ...STD_COLUMNS.map((name) => cell[name] ?? 'NaN'),
      ].join(','),
    );
  }
  return out.join('\n');
}
