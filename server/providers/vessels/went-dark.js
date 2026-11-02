import {
  SHIP_DARK_CONFIG,
  WENT_DARK_ENABLED_DEFAULT,
  createDarkTracker,
} from '../../../src/data/wentDark.js';
import { blackoutStore } from '../../blackout/persist.js';
import { createFlagLog } from '../../blackout/flagLog.js';
import { coastDistanceKm } from '../../blackout/places.js';

/**
 * Extra ship-only noise filters applied to the detector's flags (2026-11-02).
 * AIS reception naturally drops near coasts, in ports, rivers and anchorages,
 * and the same ship tends to flicker dark again and again. Measured on the
 * live 24 h history before this change: 7,337 ship flags/day; with these
 * filters plus the 60 min / 5 kt detector thresholds: ~750/day.
 * - minCoastKm: last fix at least this far from the 1:110m coastline (and not
 *   over land/inland waterways).
 * - repeatWindowMs: one flag per ship per this window (a new silence of the
 *   same MMSI within it is not re-flagged).
 */
export const SHIP_FLAG_FILTER = Object.freeze({ minCoastKm: 20, repeatWindowMs: 24 * 3_600_000 });
const coastCache = new Map();
function nearCoast(f) {
  const key = `${f.id}:${f.lastAt}`;
  let d = coastCache.get(key);
  if (d === undefined) {
    d = coastDistanceKm(f.lat, f.lon, SHIP_FLAG_FILTER.minCoastKm + 1);
    if (coastCache.size > 20_000) coastCache.clear();
    coastCache.set(key, d);
  }
  return d < SHIP_FLAG_FILTER.minCoastKm;
}
/** Drop coastal flags and repeats of a ship already flagged in the window. */
export function filterShipFlags(result, log, nowMs) {
  if (!result || !Array.isArray(result.flagged)) return result;
  const extra = { nearCoast: 0, repeat: 0 };
  const flagged = [];
  for (const f of result.flagged) {
    if (nearCoast(f)) { extra.nearCoast += 1; continue; }
    const prev = log?.get?.(String(f.id));
    if (prev && prev.lastAt !== f.lastAt && nowMs - prev.flaggedAt < SHIP_FLAG_FILTER.repeatWindowMs) { extra.repeat += 1; continue; }
    flagged.push(f);
  }
  const candidates = result.candidates ? { ...result.candidates, ...extra, flagged: flagged.length } : result.candidates;
  return { ...result, flagged, candidates };
}

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
      minCoastKm: SHIP_FLAG_FILTER.minCoastKm,
      repeatWindowMs: SHIP_FLAG_FILTER.repeatWindowMs,
    },
  };
  if (!wentDarkEnabled()) {
    return { ...base, enabled: false, status: 'off', reason: 'disabled by WENT_DARK_ENABLED', flagged: [], tracked: 0, steady: 0 };
  }
  const result = filterShipFlags(tracker().evaluate(nowMs), shipFlagLog(), nowMs);
  shipFlagLog().update(result, nowMs, (id) => _tracker.lastHeardAt(id));
  return { ...base, enabled: true, generatedAt: nowMs, restoredFrom: _tracker.restoredFrom, ...result };
}

/** Test hook. */
export function resetShipWentDark() {
  _tracker = null;
  _log = null;
}
