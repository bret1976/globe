import { placeName, areasAt } from './places.js';

/**
 * Blackout activity: the live event feed and the long disappearance history.
 *
 * Both are built from the detectors' own went-dark logs (ships: AISStream,
 * aircraft: adsb.lol /v2/mil) and the GNSS region poller — nothing is
 * invented. A tick folds the latest logs in; a target seen for the first
 * time becomes a history entry and a "went dark" event, a later report marks
 * it "reappeared". History outlives the 24 h detector logs (90 days, capped)
 * and is saved on the persistent volume with everything else.
 */
export const EVENTS_MAX = 5_000;
export const EVENTS_RETENTION_MS = 14 * 86_400_000;
export const HISTORY_MAX = 20_000;
export const HISTORY_RETENTION_MS = 90 * 86_400_000;
export const GNSS_RISE_MIN_SHARE = 0.2;
export const GNSS_RISE_MIN_STEP = 0.1;
export const GNSS_RISE_MIN_AIRCRAFT = 5;
export const GNSS_RISE_COOLDOWN_MS = 3 * 3_600_000;

const KIND_WORD = { ship: 'Ship', 'military-aircraft': 'Military aircraft' };
const where = (place) => (!place ? 'at an unknown position' : place.startsWith('land at') ? `over ${place}` : `near ${place}`);
const pct = (x) => `${Math.round(x * 100)}%`;
const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export function eventText(ev) {
  const who = `${KIND_WORD[ev.kind] || 'Target'} ${ev.label || ev.targetId}`;
  if (ev.type === 'went_dark') return `${who} ${ev.kind === 'ship' ? 'lost signal' : 'went dark'} ${where(ev.place)}`;
  if (ev.type === 'reappeared') return `${who} reappeared after ${ev.durationMin} min dark (last seen ${where(ev.place)})`;
  if (ev.type === 'gnss_rise') return `GPS interference rose in ${ev.regionName}: ${pct(ev.share)} of ${ev.aircraft} aircraft degraded (was ${pct(ev.prevShare)})`;
  return ev.type;
}

export function createActivity({ store, now = () => Date.now(), sources = {} } = {}) {
  /** @type {object[]} oldest first */
  let events = [];
  /** @type {Map<string, object>} key kind:id:lastAt */
  const history = new Map();
  const regionPrev = new Map();
  const regionLastRise = new Map();
  const listeners = new Set();
  let seq = 0;
  let lastTickAt = null;
  let ticks = 0;

  const saved = store?.register('activity', () => ({ v: 1, seq, events, history: [...history.values()], regionLastRise: Object.fromEntries(regionLastRise) }));
  if (saved?.v === 1) {
    seq = Number(saved.seq) || 0;
    if (Array.isArray(saved.events)) events = saved.events.filter((e) => e?.id && Number.isFinite(e.at));
    if (Array.isArray(saved.history)) for (const h of saved.history) if (h?.key) history.set(h.key, h);
    for (const [k, v] of Object.entries(saved.regionLastRise || {})) if (Number.isFinite(v)) regionLastRise.set(k, v);
  }
  const restoredEvents = events.length;
  const restoredHistory = history.size;

  function emit(ev) {
    seq += 1;
    const full = { id: String(seq), provenance: 'inferred', ...ev };
    full.text = eventText(full);
    events.push(full);
    for (const fn of listeners) { try { fn(full); } catch { /* a broken listener never stops the feed */ } }
    return full;
  }

  function prune(t) {
    const cut = t - EVENTS_RETENTION_MS;
    let i = 0;
    while (i < events.length && events[i].at < cut) i += 1;
    if (i) events = events.slice(i);
    if (events.length > EVENTS_MAX) events = events.slice(events.length - EVENTS_MAX);
    const hcut = t - HISTORY_RETENTION_MS;
    for (const [k, h] of history) if (h.flaggedAt < hcut) history.delete(k);
    if (history.size > HISTORY_MAX) {
      const old = [...history.values()].sort((a, b) => a.flaggedAt - b.flaggedAt).slice(0, history.size - HISTORY_MAX);
      for (const h of old) history.delete(h.key);
    }
  }

  function foldFlags(kind, list, t) {
    const fresh = [];
    for (const f of list || []) {
      if (!f?.id || !Number.isFinite(f.lastAt)) continue;
      const key = `${kind}:${f.id}:${f.lastAt}`;
      let h = history.get(key);
      if (!h) {
        const place = placeName(f.lat, f.lon);
        h = {
          key, id: String(f.id), kind, label: f.label == null ? String(f.id) : String(f.label),
          lat: round(f.lat), lon: round(f.lon), place, areas: areasAt(f.lat, f.lon),
          lastSeenAt: f.lastAt, flaggedAt: Number.isFinite(f.flaggedAt) ? f.flaggedAt : t,
          reappearedAt: null, durationMin: null,
          speedMps: round(f.speed, 1), headingDeg: round(f.heading, 0), altitudeM: round(f.altitudeM, 0),
        };
        history.set(key, h);
        fresh.push(h);
      }
      if (!h.reappearedAt && Number.isFinite(f.reappearedAt)) {
        h.reappearedAt = f.reappearedAt;
        h.durationMin = Math.max(0, Math.round((f.reappearedAt - h.lastSeenAt) / 60_000));
        h._reappearedNew = true;
      }
    }
    // Emit in time order so the feed reads chronologically.
    fresh.sort((a, b) => a.flaggedAt - b.flaggedAt);
    for (const h of fresh) {
      emit({ type: 'went_dark', at: h.flaggedAt, kind, targetId: h.id, label: h.label, lat: h.lat, lon: h.lon, place: h.place, areas: h.areas, lastSeenAt: h.lastSeenAt });
    }
    for (const h of history.values()) {
      if (h.kind !== kind || !h._reappearedNew) continue;
      delete h._reappearedNew;
      emit({ type: 'reappeared', at: h.reappearedAt, kind, targetId: h.id, label: h.label, lat: h.lat, lon: h.lon, place: h.place, areas: h.areas, lastSeenAt: h.lastSeenAt, durationMin: h.durationMin });
    }
  }

  function foldRegions(list, t) {
    for (const r of list || []) {
      if (!r?.id || r.error || !Number.isFinite(r.share) || !Number.isFinite(r.aircraft)) continue;
      const prev = regionPrev.get(r.id);
      regionPrev.set(r.id, { share: r.share, at: r.at });
      if (!prev || prev.at === r.at) continue;
      const rose = r.aircraft >= GNSS_RISE_MIN_AIRCRAFT && r.share >= GNSS_RISE_MIN_SHARE && r.share - prev.share >= GNSS_RISE_MIN_STEP;
      if (!rose || t - (regionLastRise.get(r.id) ?? -Infinity) < GNSS_RISE_COOLDOWN_MS) continue;
      regionLastRise.set(r.id, t);
      const lat = r.anchor?.lat, lon = r.anchor?.lon;
      emit({ type: 'gnss_rise', at: Number.isFinite(r.at) ? r.at : t, kind: 'gnss', targetId: r.id, label: r.name, regionName: r.name, lat, lon, place: r.name, areas: [r.id, ...areasAt(lat, lon).filter((a) => a !== r.id)], share: round(r.share, 3), prevShare: round(prev.share, 3), aircraft: r.aircraft });
    }
  }

  function tick(t = now()) {
    ticks += 1;
    try { foldFlags('ship', sources.shipFlags?.(t), t); } catch { /* source failure shows in health */ }
    try { foldFlags('military-aircraft', sources.milFlags?.(t), t); } catch { /* idem */ }
    try { foldRegions(sources.regions?.(t), t); } catch { /* idem */ }
    prune(t);
    lastTickAt = t;
  }

  /** Events newer than id `since` (or the newest `limit`), newest first. */
  function list({ since = null, limit = 200, type = null, kind = null } = {}) {
    const s = Number(since);
    let out = Number.isFinite(s) && s > 0 ? events.filter((e) => Number(e.id) > s) : events;
    if (type) out = out.filter((e) => e.type === type);
    if (kind) out = out.filter((e) => e.kind === kind);
    return out.slice(-Math.max(1, Math.min(1000, limit))).reverse();
  }

  /** Disappearance history, newest first, filtered. */
  function historyList({ kind = null, state = null, area = null, q = '', sinceMs = null, limit = 500 } = {}, t = now()) {
    const needle = String(q || '').trim().toLowerCase();
    const out = [];
    for (const h of history.values()) {
      if (kind && h.kind !== kind) continue;
      if (state === 'reappeared' && !h.reappearedAt) continue;
      if (state === 'dark' && h.reappearedAt) continue;
      if (area && !(h.areas || []).includes(area)) continue;
      if (Number.isFinite(sinceMs) && h.flaggedAt < sinceMs) continue;
      if (needle && !`${h.label} ${h.id} ${h.place}`.toLowerCase().includes(needle)) continue;
      out.push(h);
    }
    out.sort((a, b) => b.flaggedAt - a.flaggedAt);
    const total = out.length;
    return {
      total,
      rows: out.slice(0, Math.max(1, Math.min(HISTORY_MAX, limit))).map((h) => ({
        ...h, darkMin: h.reappearedAt ? h.durationMin : Math.max(0, Math.round((t - h.lastSeenAt) / 60_000)), state: h.reappearedAt ? 'reappeared' : 'dark',
      })),
    };
  }

  return {
    tick, list, historyList,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    status: () => ({ events: events.length, history: history.size, lastTickAt, ticks, restoredEvents, restoredHistory, newestEventId: events.length ? events[events.length - 1].id : null, listeners: listeners.size }),
  };
}
