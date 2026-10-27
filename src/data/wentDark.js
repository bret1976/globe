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
  /**
   * Saved state only keeps targets heard within this long (newest first, at
   * most persistMaxTargets). A restore marks every saved target as heard
   * before a feed gap, so an older one could never be flagged on its current
   * silence anyway; keeping it only grew the file.
   */
  persistMaxAgeMs: 2 * 3_600_000,
  persistMaxTargets: 40_000,
  /** Trail points saved per target. */
  persistTrailPoints: 3,
  /** At most this many flags returned (most recent first). */
  maxFlagged: 300,
  /** Smoothing weight for the reporting-interval average. */
  ewmaAlpha: 0.3,
  /** Feed-health: the feed reads "stale" when NOTHING arrived for this long. */
  feedStaleMs: 3 * 60_000,
  /** Feed-health: a window with fewer than this share of the median rate is "partial". */
  partialRateRatio: 0.5,
  /**
   * Feed-health: the partial check averages this many latest complete
   * minutes. AISStream is a bursty push stream (measured 2026-10-26: single
   * minutes swing from ~4,000 to ~500 position reports and back), so a
   * one-minute check read "partial" every few minutes — and each partial read
   * voids every ship heard before it, so no ship could ever stay silent 20 min
   * "cleanly". A 3-minute average still catches a real sustained drop.
   */
  partialWindowMin: 3,
  /**
   * 'overlap': feed trouble only removes the bad stretch from a target's
   * silence — a target is flagged when its CLEAN (feed-healthy) silence alone
   * reaches the threshold. The default 'sticky' rule voids every target heard
   * before ANY bad moment, which on bursty AISStream voided every ship.
   */
  gapRule: 'overlap',
  /**
   * Grace around every feed outage (socket closed / reconnecting). The bad
   * stretch removed from a ship's silence is widened by these margins:
   * BEFORE, because AISStream drops whatever it had buffered for us when the
   * socket dies and the watchdog only notices on its next 15 s tick; AFTER,
   * because a fresh subscription takes a moment to deliver every area again.
   * Without this a ship heard just before a reconnect could be flagged
   * "dark" for silence that was really the feed's.
   */
  outagePadBeforeMs: 90_000,
  outagePadAfterMs: 60_000,
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
  /** Bad-feed stretches [start, end] (merged, oldest first) and trip stats. */
  let badSpans = [];
  const trips = { degraded: 0, stale: 0, partial: 0, gap: 0, restart: 0 };
  const recentTrips = [];
  let prevEvalAt = null;
  /** Last moment of a HARD outage (gap, stale, degraded, restart). */
  let lastHardBadAt = null;
  let degradedSince = null;
  const padBefore = Math.max(0, Number(cfg.outagePadBeforeMs) || 0);
  const padAfter = Math.max(0, Number(cfg.outagePadAfterMs) || 0);
  function markBad(start, end, cause, hard = cause !== 'partial', reason = null) {
    if (!(end >= start)) start = end;
    if (hard) lastHardBadAt = Math.max(lastHardBadAt ?? -Infinity, end);
    // Feed outages (watchdog not live) get grace on both sides; the trip log
    // keeps the raw times.
    const spanStart = cause === 'degraded' ? start - padBefore : start;
    const spanEnd = cause === 'degraded' ? end + padAfter : end;
    const last = badSpans[badSpans.length - 1];
    const lastTrip = recentTrips[recentTrips.length - 1];
    if (last && spanStart <= last[1] + 1) {
      last[0] = Math.min(last[0], spanStart);
      last[1] = Math.max(last[1], spanEnd);
      if (lastTrip && lastTrip.cause === cause && start <= lastTrip.end + 1) { lastTrip.end = Math.max(lastTrip.end, end); return; }
    } else badSpans.push([spanStart, spanEnd]);
    trips[cause] = (trips[cause] || 0) + 1;
    recentTrips.push(reason ? { cause, start, end, reason } : { cause, start, end });
    while (recentTrips.length > 20) recentTrips.shift();
    while (badSpans.length > 2000) badSpans.shift();
  }
  function badOverlap(from, to) {
    let ms = 0;
    for (const [a, b] of badSpans) {
      if (b < from) continue;
      if (a > to) break;
      ms += Math.min(b, to) - Math.max(a, from);
    }
    return ms;
  }
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
      markBad(lastReportAt, nowMs - 1, 'gap');
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
      if (t.resumeGap) {
        // First report after a restore: the gap is our downtime, not the target's.
        delete t.resumeGap;
      } else if (nowMs === t.lastAt) {
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
      if (degradedNow && degradedSince != null) {
        // A watchdog blip (socket recycle/reconnect) shorter than the stale
        // budget is a short bad stretch, not an outage: data kept flowing.
        const span = nowMs - degradedSince;
        markBad(degradedSince, nowMs, 'degraded', span >= cfg.feedStaleMs, degradedReason);
      }
      degradedNow = false;
      degradedReason = null;
      degradedSince = null;
      return;
    }
    if (!degradedNow) degradedSince = nowMs;
    degradedNow = true;
    degradedReason = reason || 'feed degraded';
    lastDegradedAt = nowMs;
    // Long enough to be an outage → hard from now on.
    if (nowMs - degradedSince >= cfg.feedStaleMs) markBad(degradedSince, nowMs, 'degraded', true, degradedReason);
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
    const w = Math.max(1, Math.min(Math.floor(cfg.partialWindowMin || 1), complete.length - cfg.partialMinHistoryMin));
    // Minutes with no entry inside the window count as zero.
    const firstMin = latest[0] - w + 1;
    const recent = complete.filter(([m]) => m >= firstMin).reduce((sum, [, n]) => sum + n, 0) / w;
    const prior = complete.filter(([m]) => m < firstMin).map(([, n]) => n);
    const med = median(prior);
    return med > 0 && recent < med * cfg.partialRateRatio;
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
    while (badSpans.length && nowMs - badSpans[0][1] > cfg.retentionMs) badSpans.shift();
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
    if (status === 'stale' || status === 'partial' || status === 'degraded') {
      lastDegradedAt = nowMs;
      // The stretch since the previous evaluation is suspect (conservative).
      if (status !== 'degraded') markBad(prevEvalAt != null && nowMs - prevEvalAt <= 5 * 60_000 ? prevEvalAt : nowMs - 60_000, nowMs, status);
    }
    prevEvalAt = nowMs;

    let steady = 0;
    const flagged = [];
    // Why steady, silent targets were (not) flagged — plain counters, no ids.
    const candidates = { silent: 0, notMoving: 0, feedGap: 0, fewPeers: 0, flagged: 0 };
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
      candidates.silent += 1;
      if (!isMovingReport(t, cfg)) { candidates.notMoving += 1; continue; }
      // Feed trouble after its last report → the silence may be the feed's.
      if (cfg.gapRule === 'overlap') {
        // A hard outage (no data / watchdog not live / restart) after its last
        // report voids it: the feed may not re-deliver it. A bursty low-rate
        // ("partial") stretch only removes that stretch from its silence.
        if (lastHardBadAt != null && lastHardBadAt >= t.lastAt) { candidates.feedGap += 1; continue; }
        if (silentMs - badOverlap(t.lastAt, nowMs) < threshold) { candidates.feedGap += 1; continue; }
      } else if (lastDegradedAt != null && lastDegradedAt >= t.lastAt) { candidates.feedGap += 1; continue; }
      const peers = peersNear(t, nowMs);
      if (peers < cfg.minPeers) { candidates.fewPeers += 1; continue; }
      candidates.flagged += 1;
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
      lastDegradedAt,
      candidates,
      feedTrips: { byCause: { ...trips }, recent: recentTrips.slice(-8), badMsLastHour: badOverlap(nowMs - 3_600_000, nowMs) },
    };
  }

  /**
   * Plain-JSON copy of what the tracker knows, for a persistent store.
   * Feed-health flags are kept so a restore never forgets a degraded feed.
   */
  function exportState(nowMs = Date.now()) {
    const maxAge = Number.isFinite(cfg.persistMaxAgeMs) ? cfg.persistMaxAgeMs : cfg.retentionMs;
    const maxN = Number.isFinite(cfg.persistMaxTargets) ? cfg.persistMaxTargets : cfg.maxTargets;
    const trailN = Number.isFinite(cfg.persistTrailPoints) ? cfg.persistTrailPoints : 4;
    const keep = [...targets.values()].filter((t) => nowMs - t.lastAt <= maxAge);
    if (keep.length > maxN) keep.sort((a, b) => b.lastAt - a.lastAt).length = maxN;
    const r5 = (x) => (Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : x);
    return {
      v: 1,
      kind: cfg.kind,
      startedAt,
      lastReportAt,
      lastDegradedAt,
      badSpans: badSpans.filter(([, b]) => nowMs - b <= maxAge),
      targets: keep.map((t) => {
        const o = { ...t, lat: r5(t.lat), lon: r5(t.lon), ewma: Number.isFinite(t.ewma) ? Math.round(t.ewma) : t.ewma, trail: t.trail.slice(-trailN).map(([lon, lat, at]) => [r5(lon), r5(lat), at]) };
        delete o.cellR;
        delete o.cellC;
        delete o.resumeGap;
        for (const k of ['altitudeM', 'verticalRateMps', 'heading', 'speed']) if (o[k] == null) delete o[k];
        if (!o.onGround) delete o.onGround;
        return o;
      }),
    };
  }

  /**
   * Load a saved state. The time the process was down is a whole-feed gap:
   * targets last heard before it are never flagged on that silence (the
   * observe() gap rule marks the feed degraded on the first new report).
   * @returns {number} Targets restored.
   */
  function importState(saved, nowMs = Date.now()) {
    if (!saved || saved.v !== 1 || saved.kind !== cfg.kind || !Array.isArray(saved.targets)) return 0;
    let n = 0;
    for (const raw of saved.targets) {
      if (!raw?.id || !Number.isFinite(raw.lastAt) || nowMs - raw.lastAt > cfg.retentionMs) continue;
      if (targets.has(String(raw.id))) continue;
      if (targets.size >= cfg.maxTargets) break;
      const t = { ...raw, resumeGap: true, id: String(raw.id), trail: Array.isArray(raw.trail) ? raw.trail.slice(-cfg.trailPoints) : [] };
      const [r, c] = cellOf(t.lat, t.lon, cfg.cellDeg);
      t.cellR = r;
      t.cellC = c;
      targets.set(t.id, t);
      const key = cellKey(r, c);
      let set = cells.get(key);
      if (!set) cells.set(key, (set = new Set()));
      set.add(t.id);
      n += 1;
    }
    if (Number.isFinite(saved.lastReportAt) && (lastReportAt == null || saved.lastReportAt > lastReportAt)) lastReportAt = saved.lastReportAt;
    // Everything restored was heard before the downtime: mark that.
    if (Array.isArray(saved.badSpans)) for (const sp of saved.badSpans) if (Array.isArray(sp) && Number.isFinite(sp[0]) && Number.isFinite(sp[1])) badSpans.push([sp[0], sp[1]]);
    badSpans.sort((a, b) => a[0] - b[0]);
    if (Number.isFinite(lastReportAt)) markBad(lastReportAt, nowMs, 'restart');
    lastDegradedAt = Math.max(lastDegradedAt ?? -Infinity, Number(saved.lastDegradedAt) || -Infinity, lastReportAt ?? -Infinity);
    restoredFrom = Number.isFinite(saved.startedAt) ? saved.startedAt : null;
    return n;
  }

  let restoredFrom = null;

  return {
    config: cfg,
    observe,
    noteFeedHealth,
    evaluate,
    exportState,
    importState,
    lastHeardAt: (id) => targets.get(String(id))?.lastAt ?? null,
    get restoredFrom() {
      return restoredFrom;
    },
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
