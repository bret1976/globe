/**
 * Live-map payload: every tracked ship (AISStream) and military aircraft
 * (adsb.lol /v2/mil) as compact arrays, plus the targets currently flagged as
 * went-dark. Ships are thinned server-side with a lat/lon grid (one
 * representative per cell, carrying the cell's count) so ~25k vessels stay
 * cheap to send and draw. Positions are observed; dark flags are inferred.
 */
export const LIVE_CACHE_MS = 3_000;
export const MAX_POINTS = 8_000;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const num = (v) => (Number.isFinite(v) ? v : null);

export function parseBbox(raw) {
  if (!raw) return null;
  const p = String(raw).split(',').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) return null;
  let [w, s, e, n] = p;
  s = Math.max(-90, s); n = Math.min(90, n);
  if (s >= n) return null;
  if (e - w >= 360) { w = -180; e = 180; }
  return [w, s, e, n];
}

function inBox(lon, lat, b) {
  if (!b) return true;
  if (lat < b[1] || lat > b[3]) return false;
  const [w, , e] = b;
  if (w >= -180 && e <= 180) return lon >= w && lon <= e;
  // Box crossing the antimeridian (w < -180 or e > 180).
  const L = ((lon + 540) % 360) - 180;
  return (L >= w && L <= e) || (L + 360 >= w && L + 360 <= e) || (L - 360 >= w && L - 360 <= e);
}

/** Grid-thin [id, lon, lat, ...] rows: one per cell (the newest), with n = count. */
export function thin(rows, grid) {
  if (!(grid > 0)) return rows.map((r) => [...r, 1]);
  const cells = new Map();
  for (const r of rows) {
    const k = `${Math.floor(r[1] / grid)}:${Math.floor(r[2] / grid)}`;
    const c = cells.get(k);
    if (!c) cells.set(k, { row: r, n: 1 });
    else { c.n += 1; if (r[5] < c.row[5]) c.row = r; }
  }
  return [...cells.values()].map((c) => [...c.row, c.n]);
}

export function createLive({ shipRows, aircraft, dark, now = () => Date.now() }) {
  let cache = null;

  function all(t) {
    if (cache && t - cache.t < LIVE_CACHE_MS) return cache;
    const ships = [];
    for (const v of shipRows() || []) {
      const lat = Number(v.lat), lon = Number(v.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const at = Number.isFinite(v.last_position_epoch) ? v.last_position_epoch * 1000 : Date.parse(v.last_position_UTC);
      ships.push([String(v.mmsi), r4(lon), r4(lat), num(Number(v.course)), num(Number(v.speed)), Number.isFinite(at) ? Math.max(0, Math.round((t - at) / 1000)) : null]);
    }
    const ac = aircraft() || { list: [] };
    const planes = [];
    for (const a of ac.list || []) {
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
      planes.push([String(a.id), r4(a.lon), r4(a.lat), num(a.heading), Number.isFinite(a.speed) ? Math.round(a.speed * 1.943844) : null, Number.isFinite(a.at) ? Math.max(0, Math.round((t - a.at) / 1000)) : null, a.label || null, a.type || null, Number.isFinite(a.altitudeM) ? Math.round(a.altitudeM) : null]);
    }
    const d = dark(t) || [];
    cache = { t, ships, planes, dark: d, aircraftAt: ac.at ?? null };
    return cache;
  }

  /** @param {{kinds?:string[], bbox?:number[]|null, grid?:number}} q */
  function payload({ kinds = ['ships', 'aircraft', 'dark'], bbox = null, grid = 0 } = {}, t = now()) {
    const a = all(t);
    const out = { generatedAt: new Date(t).toISOString(), refreshS: 5, provenance: { positions: 'observed', dark: 'inferred' } };
    if (kinds.includes('ships')) {
      const vis = a.ships.filter((r) => inBox(r[1], r[2], bbox));
      let g = Math.max(0, Math.min(10, Number(grid) || 0));
      let rows = thin(vis, g);
      while (rows.length > MAX_POINTS && g < 10) { g = g ? g * 2 : 0.25; rows = thin(vis, g); }
      out.ships = { total: a.ships.length, visible: vis.length, grid: g, fields: ['mmsi', 'lon', 'lat', 'cogDeg', 'sogKt', 'ageS', 'n'], rows };
    }
    if (kinds.includes('aircraft')) {
      out.aircraft = { total: a.planes.length, snapshotAt: a.aircraftAt ? new Date(a.aircraftAt).toISOString() : null, fields: ['hex', 'lon', 'lat', 'headingDeg', 'speedKt', 'ageS', 'callsign', 'type', 'altitudeM'], rows: a.planes.filter((r) => inBox(r[1], r[2], bbox)) };
    }
    if (kinds.includes('dark')) out.dark = a.dark;
    out.attribution = ['AIS positions: AISStream.io', 'Military ADS-B: adsb.lol (ODbL 1.0)', 'Coastlines: Natural Earth (public domain)'];
    return out;
  }

  return { payload };
}
