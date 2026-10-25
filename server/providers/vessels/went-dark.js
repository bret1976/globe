import {
  SHIP_DARK_CONFIG,
  WENT_DARK_ENABLED_DEFAULT,
  createDarkTracker,
} from '../../../src/data/wentDark.js';
import { blackoutStore } from '../../blackout/persist.js';
import { createFlagLog } from '../../blackout/flagLog.js';

/**
 * Server-side "went dark" tracker for AISStream ships. In memory, saved to
 * the Blackout persistent directory when one is attached (see
 * server/blackout/persist.js); otherwise a restart starts from zero.
 *
 * Off switch: WENT_DARK_ENABLED=0 (or "false"/"off").
 */
export function wentDarkEnabled() {
  const raw = String(process.env.WENT_DARK_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return WENT_DARK_ENABLED_DEFAULT;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

let _tracker = null;
let _log = null;
function tracker() {
  if (!_tracker) {
    const t = createDarkTracker(SHIP_DARK_CONFIG);
    const saved = blackoutStore().register('ships-dark', () => t.exportState());
    if (saved) t.importState(saved);
    _tracker = t;
  }
  return _tracker;
}

/** 24 h log of ship went-dark flags (persisted with the tracker). */
export function shipFlagLog() {
  if (!_log) {
    const log = createFlagLog();
    const saved = blackoutStore().register('ships-flags', () => log.exportState());
    if (saved) log.importState(saved);
    _log = log;
  }
  return _log;
}

/** Called by the AIS store for every accepted position report. Never throws. */
export function observeShipForWentDark(vessel, nowMs = Date.now()) {
  if (!wentDarkEnabled()) return;
  try {
    tracker().observe(
      {
        id: vessel.mmsi,
        lat: vessel.lat,
        lon: vessel.lon,
        label: vessel.name,
        speed: vessel.speed,
        heading: vessel.heading ?? vessel.course,
      },
      nowMs,
    );
  } catch {
    // Detector must never break ingestion.
  }
}

/** Feed status from the AIS watchdog ('live' is the only healthy state). */
export function noteShipFeedStatus(status, nowMs = Date.now()) {
  if (!wentDarkEnabled() || !_tracker) return;
  _tracker.noteFeedHealth(status === 'live', `AIS feed ${status}`, nowMs);
}

/** JSON body for /api/ais-live/dark. */
export function shipWentDarkSnapshot(nowMs = Date.now()) {
  const base = {
    source: blackoutStore().status().mode === 'disk' ? 'AISStream (persisted across restarts)' : 'AISStream (in-memory since server start)',
    provenance: 'inferred',
    thresholds: {
      minReports: SHIP_DARK_CONFIG.minReports,
      maxTypicalIntervalMs: SHIP_DARK_CONFIG.maxTypicalIntervalMs,
      darkAfterMs: SHIP_DARK_CONFIG.darkAfterMs,
      intervalMultiple: SHIP_DARK_CONFIG.intervalMultiple,
      minSpeedKt: SHIP_DARK_CONFIG.minSpeedKt,
      minPeers: SHIP_DARK_CONFIG.minPeers,
      peerWindowMs: SHIP_DARK_CONFIG.peerWindowMs,
    },
  };
  if (!wentDarkEnabled()) {
    return { ...base, enabled: false, status: 'off', reason: 'disabled by WENT_DARK_ENABLED', flagged: [], tracked: 0, steady: 0 };
  }
  const result = tracker().evaluate(nowMs);
  shipFlagLog().update(result, nowMs, (id) => _tracker.lastHeardAt(id));
  return { ...base, enabled: true, generatedAt: nowMs, restoredFrom: _tracker.restoredFrom, ...result };
}

/** Test hook. */
export function resetShipWentDark() {
  _tracker = null;
  _log = null;
}
