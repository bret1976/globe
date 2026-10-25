/**
 * "Went dark" detector — pure, in-memory, no I/O.
 *
 * A target (an AIS ship or an aircraft) is flagged when it had been
 * reporting STEADILY, was MOVING at its last report, and then fell silent for
 * much longer than its own normal reporting interval — while other targets
 * around its last position kept reporting (so the silence is the target's,
 * not a coverage hole) and while the feed itself was healthy (so the silence
 * is not a stale or partial feed).
 *
 * Every threshold is a named constant below. Nothing is persisted: a restart
 * starts from zero and needs a few reports per target before it can flag.
 *
 * A flag is an INFERENCE: it says "we stopped hearing this target here", not
 * that a transponder was switched off.
 */

/** Master on/off for the feature (server env WENT_DARK_ENABLED=0 disables). */
export const WENT_DARK_ENABLED_DEFAULT = true;

/** Ships (AISStream). */
export const SHIP_DARK_CONFIG = Object.freeze({
  kind: 'ship',
  /** Reports needed before a ship counts as "steady". */
  minReports: 8,
  /** Its smoothed reporting interval must be at most this. */
  maxTypicalIntervalMs: 5 * 60_000,
  /** Silence must exceed BOTH this … */
  darkAfterMs: 20 * 60_000,
  /** … and this multiple of the ship's own typical interval. */
  intervalMultiple: 6,
  /** Moving at its last report (knots). Anchored/moored ships are ignored. */
  minSpeedKt: 2,
  /** Coverage guard: at least this many OTHER targets … */
  minPeers: 3,
  /** … reported within this window … */
  peerWindowMs: 10 * 60_000,
  /** … in the 3×3 block of cells (this many degrees) around the last fix. */
  cellDeg: 1,
  /** Last-known path kept per target for the ghost trail. */
  trailPoints: 12,
  /** Forget a silent target after this long (it is no longer "recent"). */
  retentionMs: 6 * 3_600_000,
  /** Hard cap on tracked targets (oldest evicted first). */
  maxTargets: 60_000,
  /** At most this many flags returned (most recent first). */
  maxFlagged: 300,
  /** Smoothing weight for the reporting-interval average. */
  ewmaAlpha: 0.3,
  /** Feed-health: the feed reads "stale" when NOTHING arrived for this long. */
  feedStaleMs: 3 * 60_000,
  /** Feed-health: a minute with fewer than this share of the median rate is "partial". */
  partialRateRatio: 0.5,
  /** Minutes of rate history needed before the partial-feed check applies. */
  partialMinHistoryMin: 5,
  /** Minutes of rate history kept. */
  rateHistoryMin: 30,
});

/** Aircraft (OpenSky / adsb.lol snapshots). */
export const AIRCRAFT_DARK_CONFIG = Object.freeze({
  kind: 'aircraft',
  minReports: 4,
  maxTypicalIntervalMs: 60_000,
  darkAfterMs: 3 * 60_000,
  intervalMultiple: 6,
  /** Airborne and above this altitude (metres) at its last report. */
  minAltitudeM: 3_000,
  /** Not descending faster than this (m/s, negative = down) — i.e. not landing. */
  minVerticalRateMps: -7.5,
  minPeers: 3,
  peerWindowMs: 2 * 60_000,
  cellDeg: 1,
  trailPoints: 12,
  retentionMs: 2 * 3_600_000,
  maxTargets: 40_000,
  maxFlagged: 300,
  ewmaAlpha: 0.3,
  feedStaleMs: 2 * 60_000,
  partialRateRatio: 0.5,
  partialMinHistoryMin: 5,
  rateHistoryMin: 30,
});

function cellOf(lat, lon, deg) {
  return [Math.floor((lat + 90) / deg), Math.floor((lon + 180) / deg)];
}
function cellKey(r, c) {
  return `${r}:${c}`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Was the target "moving" at its last report, per the config?
 * @param {object} t Target record.
 * @param {object} cfg Config.
 */
export function isMovingReport(t, cfg) {
  if (cfg.kind === 'ship') {
    return Number.isFinite(t.speed) && t.speed >= cfg.minSpeedKt;
  }
  if (t.onGround) return false;
  if (!Number.isFinite(t.altitudeM) || t.altitudeM < cfg.minAltitudeM)
    return false;
  if (Number.isFinite(t.verticalRateMps) && t.verticalRateMps < cfg.minVerticalRateMps)
    return false;
  return true;
}

/**
 * @param {object} [config] One of the *_DARK_CONFIG objects (overrides allowed).
 * @param {{startedAt?: number}} [options]
 */
export function createDarkTracker(config = SHIP_DARK_CONFIG, options = {}) {
  const cfg = { ...config };
  const startedAt = Number.isFinite(options.startedAt)
    ? options.startedAt
    : Date.now();
  /** @type {Map<string, object>} */
  const targets = new Map();
  /** @type {Map<string, Set<string>>} */
  const cells = new Map();
  let lastReportAt = null;
  let lastDegradedAt = null;
  let degradedReason = null;
  let degradedNow = false;
  /** per-minute report counts: [minuteIndex, count] */
  const rate = [];

  function countRate(nowMs) {
    const minute = Math.floor(nowMs / 60_000);
    const last = rate[rate.length - 1];
    if (last && last[0] === minute) last[1] += 1;
    else {
      rate.push([minute, 1]);
      while (rate.length > cfg.rateHistoryMin + 1) rate.shift();
    }
  }

  function unindex(id, t) {
    const key = cellKey(t.cellR, t.cellC);
    const set = cells.get(key);
    if (set) {
      set.delete(id);
      if (!set.size) cells.delete(key);
    }
  }

  function drop(id) {
    const t = targets.get(id);
    if (!t) return;
    unindex(id, t);
    targets.delete(id);
  }

  /**
   * Record one position report.
   * @param {{id: string, lat: number, lon: number, label?: string,
   *   speed?: number, heading?: number, altitudeM?: number,
   *   verticalRateMps?: number, onGround?: boolean}} report
   * @param {number} [nowMs] When the report ARRIVED (feed time, not the
   *   device clock — silence is measured against arrival).
   */
  function observe(report, nowMs = Date.now()) {
    if (!report?.id) return false;
    const lat = Number(report.lat);
    const lon = Number(report.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    const id = String(report.id);
    // A whole-feed gap means everyone was silent: nobody heard before it may
    // be flagged on the strength of that silence.
    if (lastReportAt != null && nowMs - lastReportAt > cfg.feedStaleMs) {
      lastDegradedAt = nowMs - 1;
    }
    if (lastReportAt == null || nowMs > lastReportAt) lastReportAt = nowMs;
    countRate(nowMs);
    const [r, c] = cellOf(lat, lon, cfg.cellDeg);
    let t = targets.get(id);
    if (!t) {
      if (targets.size >= cfg.maxTargets) evictOldest();
      t = { id, n: 0, firstAt: nowMs, lastAt: null, ewma: null, trail: [] };
      targets.set(id, t);
    } else {
      if (nowMs < t.lastAt) return false; // out of order: ignore
      if (nowMs === t.lastAt) {
        // Same-time duplicate: refresh fields, no interval sample.
      } else {
        const dt = nowMs - t.lastAt;
        t.ewma = t.ewma == null ? dt : cfg.ewmaAlpha * dt + (1 - cfg.ewmaAlpha) * t.ewma;
      }
      if (t.cellR !== r || t.cellC !== c) unindex(id, t);
    }
    if (t.lastAt == null || nowMs > t.lastAt) t.n += 1;
    t.lastAt = nowMs;
    t.lat = lat;
    t.lon = lon;
    t.cellR = r;
    t.cellC = c;
    const key = cellKey(r, c);
    let set = cells.get(key);
    if (!set) cells.set(key, (set = new Set()));
    set.add(id);
    if (report.label) t.label = String(report.label);
    t.speed = Number.isFinite(Number(report.speed)) ? Number(report.speed) : null;
    t.heading = Number.isFinite(Number(report.heading)) ? Number(report.heading) : null;
    t.altitudeM = Number.isFinite(Number(report.altitudeM)) ? Number(report.altitudeM) : null;
    t.verticalRateMps = Number.isFinite(Number(report.verticalRateMps))
      ? Number(report.verticalRateMps)
      : null;
    t.onGround = Boolean(report.onGround);
    const lastPt = t.trail[t.trail.length - 1];
    if (!lastPt || lastPt[0] !== lon || lastPt[1] !== lat) {
      t.trail.push([lon, lat, nowMs]);
      if (t.trail.length > cfg.trailPoints) t.trail.shift();
    }
    return true;
  }

  function evictOldest() {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, t] of targets) {
      if (t.lastAt < oldestAt) {
        oldestAt = t.lastAt;
        oldestId = id;
      }
    }
    if (oldestId) drop(oldestId);
  }

  /**
   * Tell the tracker whether the FEED is healthy. While unhealthy nothing is
   * flagged, and targets last heard before the problem are never flagged.
   * @param {boolean} healthy
   * @param {string} [reason]
   * @param {number} [nowMs]
   */
  function noteFeedHealth(healthy, reason = null, nowMs = Date.now()) {
    if (healthy) {
      degradedNow = false;
      degradedReason = null;
      return;
    }
    degradedNow = true;
    degradedReason = reason || 'feed degraded';
    lastDegradedAt = nowMs;
  }

  function peersNear(t, nowMs) {
    const since = nowMs - cfg.peerWindowMs;
    let count = 0;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const rows = Math.round(180 / cfg.cellDeg);
        const cols = Math.round(360 / cfg.cellDeg);
        const rr = t.cellR + dr;
        if (rr < 0 || rr >= rows) continue;
        const cc = (((t.cellC + dc) % cols) + cols) % cols;
        const set = cells.get(cellKey(rr, cc));
        if (!set) continue;
        for (const id of set) {
          if (id === t.id) continue;
          const peer = targets.get(id);
          if (peer && peer.lastAt >= since) {
            count += 1;
            if (count >= cfg.minPeers) return count;
          }
        }
      }
    }
    return count;
  }

  /** Is the feed partial (much quieter than usual) right now? */
  function partialFeed(nowMs) {
    const minute = Math.floor(nowMs / 60_000);
    // Only COMPLETE minutes, oldest-first.
    const complete = rate.filter(([m]) => m < minute);
    if (complete.length < cfg.partialMinHistoryMin + 1) return false;
    const latest = complete[complete.length - 1];
    // A minute with zero reports has no entry; treat a gap as partial too.
    if (latest[0] < minute - 1) return true;
    const prior = complete.slice(0, -1).map(([, n]) => n);
    const med = median(prior);
    return med > 0 && latest[1] < med * cfg.partialRateRatio;
  }

  /**
   * Evaluate now.
   * @param {number} [nowMs]
   * @returns {{status: 'ok'|'warming'|'stale'|'partial'|'degraded',
   *   reason: string|null, startedAt: number, tracked: number,
   *   steady: number, flagged: object[], lastReportAt: number|null}}
   */
  function evaluate(nowMs = Date.now()) {
    // Retention first.
    for (const [id, t] of targets) {
      if (nowMs - t.lastAt > cfg.retentionMs) drop(id);
    }
    let status = 'ok';
    let reason = null;
    if (degradedNow) {
      status = 'degraded';
      reason = degradedReason;
    } else if (lastReportAt == null || nowMs - lastReportAt > cfg.feedStaleMs) {
      status = 'stale';
      reason =
        lastReportAt == null
          ? 'no reports received yet'
          : `no reports for ${Math.round((nowMs - lastReportAt) / 60_000)} min`;
    } else if (partialFeed(nowMs)) {
      status = 'partial';
      reason = 'feed is delivering far fewer reports than usual';
    }
    if (status === 'stale' || status === 'partial') lastDegradedAt = nowMs;

    let steady = 0;
    const flagged = [];
    for (const t of targets.values()) {
      const isSteady =
        t.n >= cfg.minReports &&
        t.ewma != null &&
        t.ewma <= cfg.maxTypicalIntervalMs;
      if (isSteady) steady += 1;
      if (status !== 'ok' || !isSteady) continue;
      const silentMs = nowMs - t.lastAt;
      const threshold = Math.max(cfg.darkAfterMs, cfg.intervalMultiple * t.ewma);
      if (silentMs < threshold) continue;
      if (!isMovingReport(t, cfg)) continue;
      // Feed trouble after its last report → the silence may be the feed's.
      if (lastDegradedAt != null && lastDegradedAt >= t.lastAt) continue;
      const peers = peersNear(t, nowMs);
      if (peers < cfg.minPeers) continue;
      flagged.push({
        id: t.id,
        kind: cfg.kind,
        label: t.label || t.id,
        lat: t.lat,
        lon: t.lon,
        lastAt: t.lastAt,
        silentMs,
        thresholdMs: Math.round(threshold),
        typicalIntervalMs: Math.round(t.ewma),
        reports: t.n,
        peers,
        speed: t.speed,
        heading: t.heading,
        altitudeM: t.altitudeM,
        trail: t.trail.map(([lon, lat, at]) => [lon, lat, at]),
      });
    }
    flagged.sort((a, b) => b.lastAt - a.lastAt);
    return {
      status,
      reason,
      startedAt,
      tracked: targets.size,
      steady,
      flagged: flagged.slice(0, cfg.maxFlagged),
      lastReportAt,
    };
  }

  return {
    config: cfg,
    observe,
    noteFeedHealth,
    evaluate,
    get size() {
      return targets.size;
    },
  };
}

/**
 * "Last seen 4 min ago" style text for a silence.
 * @param {number} silentMs
 */
export function lastSeenText(silentMs) {
  const s = Math.max(0, Math.round(silentMs / 1000));
  if (s < 90) return `last seen ${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `last seen ${m} min ago`;
  const h = Math.floor(m / 60);
  return `last seen ${h} h ${m % 60} min ago`;
}

/** Plain-words status line for the UI. */
export function describeDarkStatus(result, label = 'feed') {
  if (!result) return `Went dark: ${label} not available.`;
  switch (result.status) {
    case 'ok':
      return `${result.flagged.length} went dark · watching ${result.steady} steady of ${result.tracked} tracked`;
    case 'stale':
      return `${label} is stale (${result.reason}) — not flagging anything until it recovers.`;
    case 'partial':
      return `${label} is partial (${result.reason}) — not flagging anything until it recovers.`;
    case 'degraded':
      return `${label} is degraded (${result.reason}) — not flagging anything until it recovers.`;
    default:
      return `${label}: ${result.reason || result.status}`;
  }
}
