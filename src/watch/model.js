/**
 * Pure logic for the /watch dashboard: feed health, went-dark rows, globe
 * deep links, the jamming timeline and the provenance table. No DOM, no
 * Cesium, no network — main.js does the fetching and drawing.
 */
import { LAYER_PROVENANCE, PROVENANCE_LABELS, creditText, formatAge } from '../provenance/provenance.js';
import { DATA_CREDITS, NATURAL_EARTH_CREDIT } from '../data/dataCreditList.js';
import { lastSeenText } from '../data/wentDark.js';
import { isWorldwideCoverage } from '../data/wentDarkAircraft.js';
import { createDefaultLayerState, encodeLayerStateParams } from '../data/layerState.js';

export const REFRESH_MS = 30_000;
export const WARMING_NOTE = 'Needs about 20 minutes of steady reports after a server restart before anything can be flagged.';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Feed states, worst last. */
export const FEED_STATES = Object.freeze(['live', 'warming', 'regional', 'partial', 'stale', 'down']);
const STATE_LABEL = { live: 'LIVE', warming: 'WARMING', regional: 'REGIONAL', partial: 'PARTIAL', stale: 'STALE', down: 'DOWN' };
export const feedStateLabel = (s) => STATE_LABEL[s] || 'UNKNOWN';

/** "5 s" / "3 min" (formatAge without its trailing "ago"). */
const ageSpan = (atMs, nowMs) => formatAge(atMs, nowMs).replace(/ ago$/, '').replace('just now', 'under 5 s');

const ageOf = (atMs, nowMs) => (Number.isFinite(atMs) ? Math.max(0, nowMs - atMs) : null);

/** Civil flights from `/api/opensky` (payload `time` + x-flight-* headers). */
export function flightsFeed(probe, nowMs) {
  const base = { id: 'flights', name: 'Flights', provider: 'OpenSky / adsb.lol' };
  if (!probe?.ok) return { ...base, state: 'down', detail: probe?.error || 'no response' };
  const at = Number.isFinite(probe.payload?.time) ? probe.payload.time * 1000 : null;
  const ageMs = ageOf(at, nowMs);
  const coverage = probe.headers?.coverage || 'unknown coverage';
  const count = Number(probe.headers?.count) || (probe.payload?.states?.length ?? 0);
  const provider = probe.headers?.source || base.provider;
  const out = { ...base, provider, atMs: at, ageMs, count, coverage };
  if (ageMs == null || ageMs > 2 * MIN) return { ...out, state: 'stale', detail: ageMs == null ? 'snapshot undated' : `snapshot ${ageSpan(at, nowMs)} old` };
  if (!isWorldwideCoverage(coverage)) return { ...out, state: 'regional', detail: `${coverage} — not a worldwide picture` };
  return { ...out, state: 'live', detail: coverage };
}

/** Military aircraft from `/api/adsblol/mil` (readsb `now` in seconds or ms). */
export function militaryFeed(probe, nowMs) {
  const base = { id: 'military', name: 'Military aircraft', provider: 'adsb.lol' };
  if (!probe?.ok) return { ...base, state: 'down', detail: probe?.error || 'no response' };
  const raw = Number(probe.payload?.now);
  const at = Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : null;
  const ageMs = ageOf(at, nowMs);
  const count = Array.isArray(probe.payload?.ac) ? probe.payload.ac.length : 0;
  const out = { ...base, atMs: at, ageMs, count };
  if (ageMs == null || ageMs > 5 * MIN) return { ...out, state: 'stale', detail: ageMs == null ? 'snapshot undated' : `snapshot ${ageSpan(at, nowMs)} old` };
  return { ...out, state: 'live', detail: 'worldwide military feed' };
}

/** AIS from `/api/ais-live/dark` (tracker status + lastReportAt). */
export function aisFeed(probe, nowMs) {
  const base = { id: 'ais', name: 'Ships (AIS)', provider: 'AISStream' };
  if (!probe?.ok) return { ...base, state: 'down', detail: probe?.error || 'no response' };
  const p = probe.payload || {};
  if (p.enabled === false) return { ...base, state: 'down', detail: p.reason || 'AIS feed not configured' };
  const at = Number.isFinite(p.lastReportAt) ? p.lastReportAt : null;
  const ageMs = ageOf(at, nowMs);
  const out = { ...base, atMs: at, ageMs, count: Number(p.tracked) || 0 };
  if (p.status === 'stale' || ageMs == null || ageMs > 5 * MIN) return { ...out, state: 'stale', detail: p.reason || 'no recent reports' };
  if (p.status === 'partial' || p.status === 'degraded') return { ...out, state: 'partial', detail: p.reason || 'feed delivering fewer reports than usual' };
  if (Number.isFinite(p.startedAt) && nowMs - p.startedAt < 20 * MIN) return { ...out, state: 'warming', detail: `server restarted ${formatAge(p.startedAt, nowMs)}` };
  return { ...out, state: 'live', detail: `${out.count.toLocaleString('en-US')} vessels in memory` };
}

/** gpsjam daily product from `/api/gpsjam/dates`. A day is complete at its UTC end. */
export function gpsjamFeed(probe, nowMs) {
  const base = { id: 'gpsjam', name: 'GPS interference', provider: 'gpsjam.org' };
  if (!probe?.ok) return { ...base, state: 'down', detail: probe?.error || 'no response' };
  const latest = probe.payload?.latest;
  const day = Date.parse(`${latest}T00:00:00Z`);
  if (!Number.isFinite(day)) return { ...base, state: 'stale', detail: 'no daily file listed' };
  const at = day + DAY;
  const ageMs = ageOf(at, nowMs);
  const out = { ...base, atMs: at, ageMs, count: probe.payload?.dates?.length || 0 };
  if (ageMs > 2 * DAY) return { ...out, state: 'stale', detail: `latest day ${latest}` };
  return { ...out, state: 'live', detail: `daily product · latest ${latest} UTC` };
}

/** GNSS integrity history from `/api/gnss-integrity/history`. Always regional. */
export function gnssFeed(probe, nowMs) {
  const base = { id: 'gnss', name: 'GNSS integrity', provider: 'adsb.lol NIC/NACp' };
  if (!probe?.ok) return { ...base, state: 'down', detail: probe?.error || 'no response' };
  const p = probe.payload || {};
  const frames = p.frames?.length || 0;
  const at = Number.isFinite(p.newestAt) ? p.newestAt + (p.bucketMs || 0) : null;
  const ageMs = ageOf(at, nowMs);
  const out = { ...base, atMs: at, ageMs, count: frames };
  if (!frames) return { ...out, state: 'warming', detail: 'no frames yet — recorded only where the globe has looked' };
  if (ageMs > 60 * MIN) return { ...out, state: 'stale', detail: `newest frame ${ageSpan(p.newestAt, nowMs)} old` };
  return { ...out, state: 'regional', detail: `${frames} five-minute frames · only regions someone viewed` };
}

/** All header rows in display order. */
export function feedHealth(probes = {}, nowMs = Date.now()) {
  return [
    flightsFeed(probes.flights, nowMs),
    militaryFeed(probes.military, nowMs),
    aisFeed(probes.ais, nowMs),
    gpsjamFeed(probes.gpsjam, nowMs),
    gnssFeed(probes.gnss, nowMs),
  ];
}

/** Banner text for any row that is not plainly live; null when all are live. */
export function healthBanner(rows) {
  const bad = rows.filter((r) => r.state !== 'live');
  if (!bad.length) return null;
  const worst = bad.reduce((a, r) => (FEED_STATES.indexOf(r.state) > FEED_STATES.indexOf(a.state) ? r : a));
  return {
    level: ['stale', 'down'].includes(worst.state) ? 'alert' : 'caution',
    text: bad.map((r) => `${r.name}: ${feedStateLabel(r.state).toLowerCase()} — ${r.detail}`).join(' · '),
  };
}

/** Globe share link that opens on a point with the given layers on. */
export function globeDeepLink({ lat, lon, altM = 120_000, layers = ['went-dark'] } = {}, base = '/') {
  const params = new URLSearchParams();
  params.set('v', '2');
  params.set('lat', Number(lat).toFixed(4));
  params.set('lon', Number(lon).toFixed(4));
  params.set('alt', String(Math.round(altM)));
  params.set('heading', '0');
  params.set('pitch', '-90');
  const state = createDefaultLayerState();
  state.enabledLayerIds = [...layers];
  encodeLayerStateParams(params, state);
  return `${base}#${params.toString()}`;
}

/**
 * Merge ship (server) and aircraft (in-page) went-dark results.
 * @returns {{rows: object[], ships: number, aircraft: number}}
 */
export function wentDarkRows(ships, aircraft, nowMs = Date.now()) {
  const shipList = ships?.status === 'ok' ? ships.flagged || [] : [];
  const airList = aircraft?.status === 'ok' ? aircraft.flagged || [] : [];
  const rows = [
    ...shipList.map((f) => ({ ...f, kind: 'ship', layer: 'ais-live-vessels', serverNow: ships.generatedAt, localAt: ships.fetchedLocalMs })),
    ...airList.map((f) => ({ ...f, kind: 'aircraft', layer: 'flights', serverNow: aircraft.feedNowMs, localAt: aircraft.fetchedLocalMs })),
  ].map((f) => {
    const silentMs = Number.isFinite(f.serverNow) ? Math.max(0, f.serverNow - f.lastAt) + Math.max(0, nowMs - (f.localAt ?? nowMs)) : f.silentMs;
    return {
      id: `${f.kind}:${f.id}`,
      kind: f.kind,
      typeLabel: f.kind === 'ship' ? 'Vessel' : 'Aircraft',
      label: f.label || f.id,
      lat: f.lat,
      lon: f.lon,
      lastAt: f.lastAt,
      lastSeen: lastSeenText(Number.isFinite(silentMs) ? silentMs : 0),
      position: formatLatLon(f.lat, f.lon),
      href: globeDeepLink({ lat: f.lat, lon: f.lon, altM: f.kind === 'ship' ? 60_000 : 150_000, layers: ['went-dark', f.layer] }),
    };
  });
  rows.sort((a, b) => b.lastAt - a.lastAt);
  return { rows, ships: shipList.length, aircraft: airList.length };
}

/** Why a went-dark side shows nothing, in plain words; null when it is live. */
export function wentDarkSideNote(result, label, nowMs = Date.now()) {
  if (!result) return `${label}: not loaded yet.`;
  if (result.enabled === false) return `${label}: off — ${result.reason || 'feed not configured'}.`;
  if (result.status !== 'ok') return `${label}: paused — ${result.reason || result.status}. Nothing is flagged while a feed is unhealthy.`;
  if (Number.isFinite(result.startedAt) && nowMs - result.startedAt < 20 * MIN) return `${label}: warming up — ${WARMING_NOTE}`;
  if (!result.flagged?.length) return `${label}: none right now · watching ${result.steady} steady of ${result.tracked} tracked.`;
  return null;
}

export function formatLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/**
 * One chronological timeline: 30 gpsjam days, then the GNSS 5-minute frames.
 * @returns {{kind: 'gpsjam'|'gnss', key: string, at: number, label: string}[]}
 */
export function jammingTimeline(gpsjamDates = [], gnssFrames = []) {
  const steps = [];
  for (const d of gpsjamDates) {
    const at = Date.parse(`${d}T00:00:00Z`);
    if (Number.isFinite(at)) steps.push({ kind: 'gpsjam', key: d, at, label: `${d} · gpsjam daily` });
  }
  for (const f of gnssFrames) {
    if (!Number.isFinite(f?.at)) continue;
    steps.push({ kind: 'gnss', key: String(f.at), at: f.at, label: `${new Date(f.at).toISOString().slice(0, 16).replace('T', ' ')} UTC · NIC/NACp` });
  }
  steps.sort((a, b) => a.at - b.at);
  return steps;
}

/** Plain words on how much jamming history exists. */
export function historyNote(gpsjamDates = [], gnss = null, nowMs = Date.now()) {
  const days = gpsjamDates.length;
  const gp = days ? `gpsjam: ${days} daily files (${gpsjamDates[0]} → ${gpsjamDates[days - 1]})` : 'gpsjam: no daily files listed';
  if (!gnss) return `${gp} · NIC/NACp: not loaded`;
  const frames = gnss.frames?.length || 0;
  const since = Number.isFinite(gnss.startedAt) ? `kept in server memory since the restart ${formatAge(gnss.startedAt, nowMs)}` : 'kept in server memory';
  if (!frames) return `${gp} · NIC/NACp: no frames yet (${since}; only regions someone viewed on the globe are recorded; lost on restart)`;
  const span = Math.max(0, (gnss.newestAt ?? 0) - (gnss.oldestAt ?? 0)) + (gnss.bucketMs || 0);
  return `${gp} · NIC/NACp: ${frames} five-minute frames covering about ${Math.round(span / MIN)} min of the possible 24 h (${since}; only viewed regions; lost on restart)`;
}

/** Highlighted regions with known recurring interference. Boxes are [w, s, e, n]. */
export const JAM_REGIONS = Object.freeze([
  { id: 'baltic', name: 'Baltic', box: [9, 53, 31, 66] },
  { id: 'black-sea', name: 'Black Sea / Ukraine', box: [27, 41, 42, 53] },
  { id: 'east-med', name: 'Eastern Med / Levant', box: [26, 29, 38, 38] },
  { id: 'gulf', name: 'Gulf / Iran', box: [44, 22, 63, 40] },
  { id: 'caucasus', name: 'Caucasus / Caspian', box: [38, 38, 52, 45] },
  { id: 'myanmar', name: 'Myanmar', box: [92, 9, 102, 29] },
]);

/** Count points per highlighted region. */
export function regionCounts(points = [], regions = JAM_REGIONS) {
  return regions.map((r) => {
    const [w, s, e, n] = r.box;
    let count = 0;
    for (const p of points) if (p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n) count += 1;
    return { ...r, count };
  });
}

/** Equirectangular projection to a w×h canvas. */
export function project(lon, lat, w, h) {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}

/** Points for one timeline step, normalized to {lat, lon, level, ring?}. */
export function jamPoints(step, payload) {
  if (!step || !payload) return [];
  if (step.kind === 'gpsjam') {
    return (payload.rows || []).map((r) => ({ lat: r.lat, lon: r.lon, level: r.level, ring: r.ring }));
  }
  const cells = payload.frame?.cells || [];
  return cells
    .filter((c) => c.state && c.state !== 'nominal')
    .map((c) => ({ lat: c.lat, lon: c.lon, level: c.level, box: [c.west, c.south, c.east, c.north] }));
}

const CREDIT_TEXT = new Map(DATA_CREDITS.map((c) => [c.key, creditText(c.html)]));
export const MAP_CREDIT_TEXT = creditText(NATURAL_EARTH_CREDIT.html);

/** Licence/attribution text for a credit key, or a fallback. */
export function licenceFor(creditKey) {
  return (creditKey && CREDIT_TEXT.get(creditKey)) || 'See DATA_SOURCES.md for this source.';
}

/** Layers whose live counts the dashboard can read cheaply. */
export const COUNTED_LAYERS = Object.freeze(['flights', 'military', 'ais-live-vessels', 'gps-interference', 'gnss-integrity', 'went-dark']);

/**
 * Provenance table: every registered layer, grouped by kind, with live counts
 * for the ones this page polls.
 * @param {Record<string, {count: number|null, atMs: number|null}>} live
 */
export function provenanceRows(live = {}, nowMs = Date.now()) {
  const rows = Object.entries(LAYER_PROVENANCE).map(([layerId, p]) => {
    const l = live[layerId];
    return {
      layerId,
      kind: p.kind,
      badge: PROVENANCE_LABELS[p.kind],
      provider: p.provider,
      note: p.note || null,
      count: l ? l.count : null,
      freshness: l?.atMs ? formatAge(l.atMs, nowMs) : l ? 'unknown' : 'not polled here',
      licence: licenceFor(p.creditKey),
    };
  });
  const order = { observed: 0, inferred: 1, simulated: 2 };
  rows.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || (b.count != null) - (a.count != null) || a.layerId.localeCompare(b.layerId));
  const totals = { observed: 0, inferred: 0, simulated: 0 };
  for (const r of rows) totals[r.kind] = (totals[r.kind] || 0) + 1;
  return { rows, totals };
}

/** "updated 12 s ago" */
export function updatedAgo(atMs, nowMs = Date.now()) {
  if (!Number.isFinite(atMs)) return 'not updated yet';
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  return s < 90 ? `updated ${s} s ago` : `updated ${Math.round(s / 60)} min ago`;
}
