/**
 * 24 h log of went-dark flags. A flag is logged the first time a target is
 * flagged; if it later reports again it is marked "reappeared". This is what
 * keeps "went dark in the last 24 h" honest across evaluations (a live flag
 * drops out of evaluate() once its retention passes or it reports again).
 */
export const FLAG_LOG_RETENTION_MS = 24 * 3_600_000;
export const FLAG_LOG_MAX = 2_000;

export function createFlagLog({ retentionMs = FLAG_LOG_RETENTION_MS, max = FLAG_LOG_MAX } = {}) {
  /** @type {Map<string, object>} */
  const entries = new Map();

  function prune(nowMs) {
    for (const [id, e] of entries) if (nowMs - e.flaggedAt > retentionMs) entries.delete(id);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  }

  /**
   * Fold one evaluate() result in.
   * @param {{status: string, flagged: object[]}} result
   * @param {(id: string) => number|null} lastHeardAt Latest report time for an id.
   */
  function update(result, nowMs, lastHeardAt = () => null) {
    const live = new Set();
    if (result?.status === 'ok') {
      for (const f of result.flagged || []) {
        const id = String(f.id);
        live.add(id);
        const prev = entries.get(id);
        // Same silence (same last fix) keeps its first-flagged time.
        if (prev && prev.lastAt === f.lastAt) { prev.silentMs = f.silentMs; prev.reappearedAt = null; continue; }
        entries.set(id, {
          id, kind: f.kind, label: f.label, lat: f.lat, lon: f.lon, lastAt: f.lastAt,
          flaggedAt: nowMs, silentMs: f.silentMs, feedGapMs: f.feedGapMs ?? null, speed: f.speed ?? null, heading: f.heading ?? null,
          altitudeM: f.altitudeM ?? null, reappearedAt: null,
        });
      }
    }
    for (const e of entries.values()) {
      if (live.has(e.id) || e.reappearedAt) continue;
      const heard = lastHeardAt(e.id);
      if (Number.isFinite(heard) && heard > e.lastAt) e.reappearedAt = heard;
    }
    prune(nowMs);
  }

  /** Newest flag first. */
  function list(nowMs) {
    prune(nowMs);
    return [...entries.values()].sort((a, b) => b.flaggedAt - a.flaggedAt).map((e) => ({ ...e }));
  }

  const exportState = () => ({ v: 1, entries: [...entries.values()] });
  function importState(saved, nowMs = Date.now()) {
    if (saved?.v !== 1 || !Array.isArray(saved.entries)) return 0;
    for (const e of saved.entries) if (e?.id && Number.isFinite(e.flaggedAt)) entries.set(String(e.id), { ...e });
    prune(nowMs);
    return entries.size;
  }
  return { update, list, exportState, importState, get size() { return entries.size; } };
}
