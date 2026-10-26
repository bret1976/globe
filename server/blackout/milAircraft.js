import { AIRCRAFT_DARK_CONFIG, createDarkTracker } from '../../src/data/wentDark.js';
import { adsbLolBudget, adsbLolTake, noteAdsbLolResponse, retryAfterMs, shareAdsbLolMilBody } from '../providers/aircraft/adsbLolGate.js';
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
/**
 * adsb.lol allows 500 requests per IP per day (x-ratelimit-limit
 * `500;w=86400`), shared by every adsb.lol caller on this host. A 30 s poll
 * alone was 2,880/day, so the feed sat in 429 most of the day. Every 5 min
 * (±10% jitter) is ~288/day and leaves room for the GNSS region poller.
 */
export const MIL_POLL_MS = 5 * 60_000;
export const MIL_POLL_JITTER = 0.1;
/** 429 backoff when upstream sends no Retry-After: 5 min doubling to 1 h. */
export const MIL_BACKOFF_MIN_MS = 5 * 60_000;
export const MIL_BACKOFF_MAX_MS = 60 * 60_000;
// Thresholds scaled to a 5-minute snapshot cadence (the civil config assumes
// reports every few seconds): typical gap up to 7 min, dark after 20 min or
// 3x its own cadence, peers counted over the last two snapshots. The feed
// reads stale only after ~2 missed snapshots, and the per-minute partial-rate
// check is off: 5-minute snapshots leave empty minutes by design.
export const MIL_DARK_CONFIG = Object.freeze({ ...AIRCRAFT_DARK_CONFIG, cellDeg: 3, minPeers: 1, maxTypicalIntervalMs: 7 * 60_000, darkAfterMs: 20 * 60_000, intervalMultiple: 3, peerWindowMs: 11 * 60_000, feedStaleMs: 12 * 60_000, partialMinHistoryMin: 1_000_000 });
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

export function createMilAircraftWatcher({ fetchImpl = globalThis.fetch, store = blackoutStore(), now = () => Date.now(), random = Math.random } = {}) {
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
  let last429At = null;
  let count429 = 0;
  let nextPollAt = null;

  async function pollOnce() {
    const t0 = now();
    if (t0 < backoffUntil) { lastError = 'adsb.lol rate-limit backoff'; return false; }
    // Shared host-wide gate: 429 cooldown seen by any route + rolling daily budget.
    if (!adsbLolTake({}, t0)) { lastError = 'adsb.lol daily budget or cooldown'; return false; }
    polls += 1;
    try {
      const res = await fetchImpl(MIL_UPSTREAM, { headers: { Accept: 'application/json', 'User-Agent': 'Blackout/1 (+https://globe-production-e799.up.railway.app/watch)' }, signal: AbortSignal.timeout(15_000) });
      noteAdsbLolResponse(res.status, res.headers, now());
      if (res.status === 429) {
        backoff429 += 1;
        count429 += 1;
        last429At = now();
        const hinted = retryAfterMs(res.headers, now());
        const base = Math.max(hinted ?? 0, MIL_BACKOFF_MIN_MS * 2 ** (backoff429 - 1));
        backoffUntil = now() + Math.min(MIL_BACKOFF_MAX_MS, base);
        res.body?.cancel?.().catch?.(() => {});
      } else if (res.ok) backoff429 = 0;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const body = JSON.parse(text);
      shareAdsbLolMilBody(text, now());
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
      source: 'adsb.lol /v2/mil (worldwide military transponders, ODbL 1.0), polled server-side every ~5 min (adsb.lol allows 500 requests/day per host)',
      pollEveryMs: MIL_POLL_MS,
      nextPollAt,
      backoffUntil: backoffUntil > nowMs ? backoffUntil : null,
      rateLimited: { count429, last429At },
      adsbLolBudget: adsbLolBudget(nowMs),
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

  /** Next delay: the interval ±jitter, never before a 429 backoff ends. */
  function nextDelay() {
    const jittered = MIL_POLL_MS * (1 + MIL_POLL_JITTER * (2 * random() - 1));
    return Math.max(jittered, backoffUntil - now() + 1_000 + random() * 30_000);
  }
  let stopped = true;
  function schedule() {
    if (stopped) return;
    const d = nextDelay();
    nextPollAt = now() + d;
    timer = setTimeout(async () => { try { await pollOnce(); } finally { schedule(); } }, d);
    timer.unref?.();
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    pollOnce().finally(schedule);
  }
  function stop() { stopped = true; clearTimeout(timer); timer = null; nextPollAt = null; }

  return { pollOnce, snapshot, positions: () => ({ at: lastSnapshotAt, okAt: lastOkAt, list: lastPositions }), recent: (n = now()) => log.list(n), start, stop, tracker };
}
