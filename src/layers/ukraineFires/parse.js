/**
 * Pure helpers for the Ukraine War Fires layer (no Cesium).
 * The proxy ships detections as a flat int array
 * [latE3 - originLat, lonE3 - originLon, dayIndex, ...] with dayIndex counted
 * from the epoch (2022-01-01 UTC).
 */
export const UKRAINE_FIRES_WINDOWS = Object.freeze([
  {
    id: 'all',
    label: 'ALL',
    days: Infinity,
    title: 'Every detection since 1 Jan 2022',
  },
  { id: '1y', label: '1Y', days: 365, title: 'Last 12 months' },
  { id: '30d', label: '30D', days: 30, title: 'Last 30 days' },
  { id: '7d', label: '7D', days: 7, title: 'Last 7 days' },
]);

/** Age bands, newest first — mirrors the reel: fresh heat glows, old fades. */
export const UKRAINE_FIRE_BANDS = Object.freeze([
  {
    id: 'week',
    label: 'Last 7 days',
    maxAge: 7,
    color: '#fff2b3',
    alpha: 0.95,
    size: 5,
  },
  {
    id: 'month',
    label: 'Last 30 days',
    maxAge: 30,
    color: '#ffb000',
    alpha: 0.85,
    size: 4,
  },
  {
    id: 'year',
    label: 'Last 12 months',
    maxAge: 365,
    color: '#ff6a1a',
    alpha: 0.6,
    size: 3,
  },
  {
    id: 'older',
    label: '2022 – earlier',
    maxAge: Infinity,
    color: '#c2331d',
    alpha: 0.38,
    size: 2.5,
  },
]);

export function bandForAge(ageDays) {
  for (let i = 0; i < UKRAINE_FIRE_BANDS.length; i++) {
    if (ageDays <= UKRAINE_FIRE_BANDS[i].maxAge) return i;
  }
  return UKRAINE_FIRE_BANDS.length - 1;
}

const EPOCH_MS = Date.UTC(2022, 0, 1);

export function dayIndexToIso(day) {
  return new Date(EPOCH_MS + day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Decode the proxy payload into typed arrays.
 * @returns {{ lat: Float32Array, lon: Float32Array, day: Uint16Array, count: number, today: number }}
 */
export function decodeUkraineFires(payload) {
  const flat = Array.isArray(payload?.points) ? payload.points : [];
  const origin = payload?.origin || { lat: 44000, lon: 22000, scale: 1000 };
  const scale = Number(origin.scale) || 1000;
  const n = Math.floor(flat.length / 3);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const day = new Uint16Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const la = (flat[i * 3] + origin.lat) / scale;
    const lo = (flat[i * 3 + 1] + origin.lon) / scale;
    const d = flat[i * 3 + 2];
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !Number.isFinite(d))
      continue;
    lat[k] = la;
    lon[k] = lo;
    day[k] = d;
    k++;
  }
  const today = Number.isFinite(payload?.today)
    ? payload.today
    : Math.floor((Date.now() - EPOCH_MS) / 86_400_000);
  return {
    lat: lat.subarray(0, k),
    lon: lon.subarray(0, k),
    day: day.subarray(0, k),
    count: k,
    today,
  };
}

/** Count detections per age band inside a window. */
export function summarizeBands(decoded, windowDays = Infinity) {
  const counts = UKRAINE_FIRE_BANDS.map(() => 0);
  let shown = 0;
  for (let i = 0; i < decoded.count; i++) {
    const age = decoded.today - decoded.day[i];
    if (age > windowDays) continue;
    counts[bandForAge(age)]++;
    shown++;
  }
  return { counts, shown };
}

/** Human coverage note for the row meta. */
export function coverageLabel(payload) {
  const cov = payload?.coverage || {};
  if (
    payload?.backfill?.running ||
    (payload?.backfill && payload.complete === false)
  ) {
    const { done = 0, total = 0 } = payload.backfill || {};
    return `backfilling 2025–26 from FIRMS · ${done}/${total}`;
  }
  if (cov.gap && Number.isFinite(cov.gap.from) && Number.isFinite(cov.gap.to)) {
    return `gap ${dayIndexToIso(cov.gap.from)} → ${dayIndexToIso(cov.gap.to)} (archive pending)`;
  }
  return 'every detection since 1 Jan 2022';
}
