import {
  AIRCRAFT_DARK_CONFIG,
  WENT_DARK_ENABLED_DEFAULT,
  createDarkTracker,
} from './wentDark.js';

/**
 * Browser-side "went dark" tracker for civil aircraft. It is fed by the
 * flights layer's accepted snapshots, so it only knows about aircraft while
 * that layer is polling. In memory only.
 */
let enabled = WENT_DARK_ENABLED_DEFAULT;
let tracker = null;
let lastObservedAtMs = null;
let lastReceivedAtMs = null;
let lastCoverage = null;
const listeners = new Set();

/** Turn the aircraft detector on or off (off drops everything it knew). */
export function setAircraftWentDarkEnabled(on) {
  enabled = Boolean(on);
  if (!enabled) resetAircraftWentDark();
}

export function resetAircraftWentDark() {
  tracker = null;
  lastObservedAtMs = null;
  lastReceivedAtMs = null;
  lastCoverage = null;
}

function getTracker() {
  if (!tracker) tracker = createDarkTracker(AIRCRAFT_DARK_CONFIG);
  return tracker;
}

/** Only a worldwide snapshot can tell "this aircraft went quiet" from "it left our query area". */
export function isWorldwideCoverage(coverage) {
  return /worldwide/i.test(String(coverage || ''));
}

/**
 * Feed one accepted flights snapshot.
 * @param {{records?: object[], observedAtMs?: number|null, stale?: boolean,
 *   freshness?: string, coverage?: string, source?: string}} snapshot
 * @param {number} [receivedAtMs]
 */
export function observeAircraftSnapshot(snapshot, receivedAtMs = Date.now()) {
  if (!enabled || !snapshot) return;
  try {
    const t = getTracker();
    const observedAtMs = Number.isFinite(snapshot.observedAtMs)
      ? snapshot.observedAtMs
      : null;
    if (observedAtMs == null || snapshot.stale || snapshot.freshness === 'stale') {
      t.noteFeedHealth(false, 'aircraft snapshot is stale or undated', observedAtMs ?? receivedAtMs);
      notify();
      return;
    }
    lastObservedAtMs = observedAtMs;
    lastReceivedAtMs = receivedAtMs;
    if (!isWorldwideCoverage(snapshot.coverage)) {
      t.noteFeedHealth(false, `aircraft feed is regional (${snapshot.coverage || 'unknown coverage'})`, observedAtMs);
      lastCoverage = snapshot.coverage || null;
      notify();
      return;
    }
    if (lastCoverage != null && lastCoverage !== snapshot.coverage) {
      t.noteFeedHealth(false, 'aircraft feed coverage changed', observedAtMs);
    }
    lastCoverage = snapshot.coverage;
    t.noteFeedHealth(true, null, observedAtMs);
    for (const r of snapshot.records || []) {
      const at = Math.max(
        Number.isFinite(r.positionTimeMs) ? r.positionTimeMs : -Infinity,
        Number.isFinite(r.contactTimeMs) ? r.contactTimeMs : -Infinity,
      );
      t.observe(
        {
          id: r.id,
          lat: r.latitude,
          lon: r.longitude,
          label: r.callsign || r.registration || r.id,
          speed: r.speedMps,
          heading: r.courseDeg,
          altitudeM: r.baroAltitudeM ?? r.ellipsoidAltitudeM,
          verticalRateMps: r.verticalRateMps,
          onGround: r.onGround,
        },
        Number.isFinite(at) ? Math.min(at, observedAtMs) : observedAtMs,
      );
    }
    notify();
  } catch {
    // Never break the flights layer.
  }
}

/**
 * Evaluate on the FEED's clock (last snapshot time plus elapsed local time),
 * so a wrong browser clock cannot invent silences.
 */
export function aircraftWentDarkSnapshot(localNowMs = Date.now()) {
  if (!enabled) {
    return { enabled: false, status: 'off', reason: 'turned off', flagged: [], tracked: 0, steady: 0 };
  }
  if (!tracker || lastObservedAtMs == null) {
    return {
      enabled: true,
      status: 'stale',
      reason: 'no aircraft snapshot yet (turn on Flights to feed it)',
      flagged: [],
      tracked: 0,
      steady: 0,
    };
  }
  const feedNow = lastObservedAtMs + Math.max(0, localNowMs - lastReceivedAtMs);
  return { enabled: true, ...tracker.evaluate(feedNow), feedNowMs: feedNow };
}

export function onAircraftWentDarkChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}
