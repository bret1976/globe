import { AIRCRAFT_DARK_CONFIG, createDarkTracker } from '../../src/data/wentDark.js';
import { blackoutStore } from './persist.js';
import { createFlagLog } from './flagLog.js';

/**
 * Worldwide went-dark detection for MILITARY transponders.
 *
 * Why military only: the free civil ADS-B feeds (adsb.lol, airplanes.live,
 * adsb.fi) cap queries at a 250 nm radius, so "went quiet" can't be told
 * apart from "left the query area". adsb.lol's /v2/mil is the one free,
 * keyless, worldwide snapshot (ODbL 1.0), so it is polled here server-side
 * and run through the same detector the globe uses.
 *
 * Military traffic is sparse, so the peer check (another aircraft still
 * heard nearby — the guard against a receiver outage) uses 3° cells and
 * one peer instead of the civil 1° / three.
 */
export const MIL_UPSTREAM = 'https://api.adsb.lol/v2/mil';
export const MIL_POLL_MS = 30_000;
export const MIL_DARK_CONFIG = Object.freeze({ ...AIRCRAFT_DARK_CONFIG, cellDeg: 3, minPeers: 1 });
const FT = 0.3048;
const KT = 0.514444;

/** adsb.lol aircraft -> detector report (null when unusable). */
export function milReport(ac, snapshotNowMs) {
  if (!ac?.hex || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return null;
  const onGround = ac.alt_baro === 'ground';
  const altFt = Number.isFinite(ac.alt_baro) ? ac.alt_baro : Number.isFinite(ac.alt_geom) ? ac.alt_geom : null;
  const rateFpm = Number.isFinite(ac.baro_rate) ? ac.baro_rate : Number.isFinite(ac.geom_rate) ? ac.geom_rate : null;
  const seen = Number.isFinite(ac.seen_pos) ? ac.seen_pos : Number.isFinite(ac.seen) ? ac.seen : 0;
  return {
    id: String(ac.hex).toLowerCase(),
    lat: ac.lat,
    lon: ac.lon,
    label: String(ac.flight || '').trim() || ac.r || String(ac.hex).toUpperCase(),
    speed: Number.isFinite(ac.gs) ? ac.gs * KT : null,
    heading: Number.isFinite(ac.track) ? ac.track : null,
    altitudeM: onGround ? 0 : altFt == null ? null : altFt * FT,
    verticalRateMps: rateFpm == null ? null : (rateFpm * FT) / 60,
    onGround,
    at: Math.round(snapshotNowMs - seen * 1000),
    type: ac.t || null,
  };
}

export function createMilAircraftWatcher({ fetchImpl = globalThis.fetch, store = blackoutStore(), now = () => Date.now() } = {}) {
  const tracker = createDarkTracker(MIL_DARK_CONFIG);
  const log = createFlagLog();
  const savedT = store.register('mil-aircraft-dark', () => tracker.exportState());
  if (savedT) tracker.importState(savedT, now());
  const savedL = store.register('mil-aircraft-flags', () => log.exportState());
  if (savedL) log.importState(savedL, now());

  let lastOkAt = null;
  let lastSnapshotAt = null;
  let lastError = null;
  let lastCount = 0;
  /** Latest positions from the last good snapshot (for the live map). */
  let lastPositions = [];
  let polls = 0;
  let timer = null;
  let backoffUntil = 0;
  let backoff429 = 0;

  async function pollOnce() {
    const t0 = now();
    // Own backoff: /v2/mil is one small request every 30 s. The shared globe
    // gate is often held by the civil regional fallback's 429s, which would
    // otherwise starve this detector indefinitely.
    if (t0 < backoffUntil) { lastError = 'adsb.lol rate-limit backoff'; return false; }
    polls += 1;
    try {
      const res = await fetchImpl(MIL_UPSTREAM, { headers: { Accept: 'application/json', 'User-Agent': 'Blackout/1 (+globe)' }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) { backoff429 += 1; backoffUntil = now() + Math.min(600_000, 30_000 * 2 ** (backoff429 - 1)); }
      else if (res.ok) backoff429 = 0;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const snapAt = Number.isFinite(body?.now) ? body.now : t0;
      const list = Array.isArray(body?.ac) ? body.ac : [];
      tracker.noteFeedHealth(true, null, snapAt);
      const positions = [];
      for (const ac of list) {
        const r = milReport(ac, snapAt);
        if (r) { tracker.observe(r, Math.min(r.at, snapAt)); positions.push(r); }
      }
      lastPositions = positions;
      lastCount = list.length;
      lastOkAt = now();
      lastSnapshotAt = snapAt;
      lastError = null;
      log.update(tracker.evaluate(snapAt), snapAt, (id) => tracker.lastHeardAt(id));
      return true;
    } catch (e) {
      lastError = e?.message || 'fetch failed';
      tracker.noteFeedHealth(false, `adsb.lol mil: ${lastError}`, now());
      return false;
    }
  }

  function snapshot(nowMs = now()) {
    const feedNow = lastSnapshotAt == null ? nowMs : lastSnapshotAt + Math.max(0, nowMs - (lastOkAt ?? nowMs));
    const base = {
      source: 'adsb.lol /v2/mil (worldwide military transponders, ODbL 1.0), polled server-side every 30 s',
      provenance: 'inferred',
      coverage: 'worldwide (military only)',
      civilNote: 'Civil aircraft are not checked: the free civil ADS-B feeds only answer a 250 nm radius, which cannot tell "went dark" from "left the area".',
      lastPollOkAt: lastOkAt,
      lastSnapshotAt,
      lastError,
      aircraftInLastSnapshot: lastCount,
      restoredFrom: tracker.restoredFrom,
      thresholds: { minReports: MIL_DARK_CONFIG.minReports, darkAfterMs: MIL_DARK_CONFIG.darkAfterMs, minAltitudeM: MIL_DARK_CONFIG.minAltitudeM, minPeers: MIL_DARK_CONFIG.minPeers, cellDeg: MIL_DARK_CONFIG.cellDeg },
    };
    if (lastOkAt == null) return { ...base, status: 'stale', reason: lastError ? `no military snapshot yet (${lastError})` : polls ? 'first poll in progress' : 'first poll pending', flagged: [], tracked: 0, steady: 0 };
    return { ...base, generatedAt: nowMs, ...tracker.evaluate(feedNow) };
  }

  function start() {
    if (timer) return;
    pollOnce();
    timer = setInterval(pollOnce, MIL_POLL_MS);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { pollOnce, snapshot, positions: () => ({ at: lastSnapshotAt, okAt: lastOkAt, list: lastPositions }), recent: (n = now()) => log.list(n), start, stop, tracker };
}
