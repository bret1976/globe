/**
 * Rolling GNSS-integrity history: the "planes as a jamming sensor network"
 * time axis.
 *
 * Every real upstream read the integrity proxy already makes is folded into
 * five-minute buckets (one entry per aircraft per 0.5° cell, degraded if any
 * fix in that bucket was degraded). A frame at time T re-bins the buckets in
 * the same 30-minute window the live layer uses, so a scrubbed frame means
 * exactly what the live overlay meant at T.
 *
 * It only records the regions people were actually looking at (the proxy
 * polls nothing on its own), and it lives in memory: a restart or redeploy
 * starts it empty. `startedAt` lets the UI say so.
 */
import {
  GNSS_CELL_DEG,
  GNSS_WINDOW_MS,
  binGnssCells,
  gnssCellKey,
} from './records.js';

/** Bucket width for history frames. */
export const GNSS_HISTORY_BUCKET_MS = 5 * 60_000;
/** How long buckets are kept. */
export const GNSS_HISTORY_RETENTION_MS = 24 * 60 * 60_000;
/** Memory guard: aircraft/cell entries kept per bucket. */
export const GNSS_HISTORY_MAX_ENTRIES_PER_BUCKET = 20_000;

/**
 * @param {{bucketMs?: number, retentionMs?: number, windowMs?: number,
 *   maxEntriesPerBucket?: number, startedAt?: number, cellDeg?: number}} [options]
 */
export function createGnssHistory({
  bucketMs = GNSS_HISTORY_BUCKET_MS,
  retentionMs = GNSS_HISTORY_RETENTION_MS,
  windowMs = GNSS_WINDOW_MS,
  maxEntriesPerBucket = GNSS_HISTORY_MAX_ENTRIES_PER_BUCKET,
  startedAt = Date.now(),
  cellDeg = GNSS_CELL_DEG,
} = {}) {
  /** @type {Map<number, Map<string, {cell: string, degraded: boolean}>>} */
  const buckets = new Map();

  const bucketOf = (ms) => Math.floor(ms / bucketMs) * bucketMs;

  function prune(nowMs) {
    const floor = nowMs - retentionMs;
    for (const start of buckets.keys()) {
      if (start + bucketMs <= floor) buckets.delete(start);
    }
  }

  /**
   * Fold one upstream snapshot in.
   * @param {Array<{hex: string, lat: number, lon: number, degraded: boolean}>} rows
   * @param {number} observedAt Snapshot time (ms).
   * @param {number} [nowMs]
   * @returns {number} Rows recorded.
   */
  function record(rows, observedAt, nowMs = observedAt) {
    if (!Number.isFinite(observedAt) || !Array.isArray(rows)) return 0;
    if (nowMs - observedAt > retentionMs || observedAt > nowMs + 60_000)
      return 0;
    const start = bucketOf(observedAt);
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = new Map();
      buckets.set(start, bucket);
    }
    let recorded = 0;
    for (const row of rows) {
      if (!Number.isFinite(row?.lat) || !Number.isFinite(row?.lon)) continue;
      if (typeof row.hex !== 'string' || !row.hex) continue;
      const cell = gnssCellKey(row.lat, row.lon, cellDeg);
      const key = `${row.hex}|${cell}`;
      const previous = bucket.get(key);
      if (!previous && bucket.size >= maxEntriesPerBucket) continue;
      bucket.set(key, {
        cell,
        degraded: Boolean(row.degraded) || Boolean(previous?.degraded),
      });
      recorded += 1;
    }
    prune(nowMs);
    return recorded;
  }

  /** Bucket starts with data, oldest first. */
  function starts(nowMs) {
    prune(nowMs);
    return [...buckets.keys()].sort((a, b) => a - b);
  }

  /**
   * The scrubbable time axis.
   * @param {number} nowMs
   */
  function timeline(nowMs) {
    const list = starts(nowMs);
    return {
      startedAt,
      bucketMs,
      windowMs,
      retentionMs,
      oldestAt: list.length ? list[0] : null,
      newestAt: list.length ? list[list.length - 1] + bucketMs : null,
      persisted: false,
      frames: list.map((start) => ({
        at: Math.min(start + bucketMs, nowMs),
        aircraft: buckets.get(start).size,
      })),
    };
  }

  /**
   * Cells as the live layer would have drawn them at `atMs`.
   * @param {number} atMs
   * @param {number} nowMs
   */
  function frame(atMs, nowMs) {
    prune(nowMs);
    if (!Number.isFinite(atMs)) return null;
    const observations = new Map();
    let contributing = 0;
    for (const [start, bucket] of buckets) {
      if (start > atMs || start + bucketMs <= atMs - windowMs) continue;
      contributing += 1;
      for (const [key, entry] of bucket) {
        const previous = observations.get(key);
        observations.set(key, {
          cell: entry.cell,
          seenAt: start,
          degradedAt:
            entry.degraded || previous?.degradedAt != null ? start : null,
        });
      }
    }
    if (!contributing) return { at: atMs, buckets: 0, cells: [] };
    return {
      at: atMs,
      buckets: contributing,
      cells: binGnssCells(observations, { cellDeg }),
    };
  }

  return {
    record,
    timeline,
    frame,
    get size() {
      return buckets.size;
    },
  };
}

/** "3 h 10 min" style span. */
export function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const utcHm = (ms) => new Date(ms).toISOString().slice(11, 16);

/**
 * Plain-words statement of how much history exists — shown in the row so a
 * freshly restarted server never looks like a quiet 24 hours.
 * @param {{startedAt: number, oldestAt: number|null, newestAt: number|null,
 *   retentionMs: number, frames: Array}|null} timeline
 * @param {number} nowMs
 */
export function describeGnssHistoryCoverage(timeline, nowMs) {
  if (!timeline) return 'History: not loaded yet';
  const since = `server memory since ${utcHm(timeline.startedAt)} UTC restart`;
  if (!timeline.frames?.length || timeline.oldestAt == null)
    return `History: none yet (${since}; only viewed regions are recorded)`;
  const span = Math.min(nowMs, timeline.newestAt) - timeline.oldestAt;
  const full = span >= timeline.retentionMs - timeline.bucketMs;
  return `History: ${formatSpan(span)} of ${formatSpan(timeline.retentionMs)}${
    full ? '' : ` (${since})`
  } · ${timeline.frames.length} five-minute frames · only viewed regions`;
}

/**
 * Slider descriptor for the row. The right-most stop is LIVE.
 * @param {{frames: Array<{at: number}>}|null} timeline
 * @param {number|null} scrubIndex Frame index, or null for live.
 * @param {number} nowMs
 */
export function gnssTimelineSlider(timeline, scrubIndex, nowMs) {
  const frames = timeline?.frames || [];
  const max = frames.length;
  const live = scrubIndex == null || scrubIndex >= max || scrubIndex < 0;
  const value = live ? max : scrubIndex;
  const at = live ? null : frames[value].at;
  return {
    id: 'gnss-history',
    min: 0,
    max,
    step: 1,
    value,
    disabled: max === 0,
    live,
    at,
    label: 'TIME',
    valueText: live
      ? 'LIVE'
      : `${utcHm(at)} UTC · ${formatSpan(nowMs - at)} ago`,
    ariaLabel: 'GNSS integrity history time',
  };
}
