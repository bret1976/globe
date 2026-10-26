import { JAM_REGIONS } from '../../src/watch/model.js';
import { adsbLolMayRequest } from '../providers/aircraft/adsbLolGate.js';

/**
 * Reads GNSS integrity (adsb.lol, 250 nm around the centre) for each Blackout
 * watch region every hour, server-side, through the same proxy the
 * globe uses. That is what lets the 24 h GNSS history fill in with nobody
 * watching. Only these six circles are sampled; the rest of the world is
 * recorded only when someone views it on the globe.
 */
// Hourly: six reads an hour is 144/day of adsb.lol's 500/day per host, next
// to the military detector's ~288 (it was every 5 min = 1,728/day).
export const REGION_POLL_MS = 60 * 60_000;

export const regionAnchor = (box) => ({ lat: Math.round((box[1] + box[3]) / 2), lon: Math.round((box[0] + box[2]) / 2) });

export function createRegionPoller({ sample, regions = JAM_REGIONS, now = () => Date.now(), gapMs = 4_000 } = {}) {
  const latest = new Map();
  let timer = null;
  let lastRunAt = null;
  let running = false;

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      for (const r of regions) {
        if (!adsbLolMayRequest()) { latest.set(r.id, { ...(latest.get(r.id) || {}), id: r.id, name: r.name, error: 'adsb.lol cooldown' }); continue; }
        const anchor = regionAnchor(r.box);
        try {
          const { value, stale } = await sample(anchor);
          const rows = value?.rows || [];
          const degraded = rows.filter((x) => x.degraded).length;
          latest.set(r.id, { id: r.id, name: r.name, anchor, radiusNm: 250, at: value?.fetchedAt ?? now(), aircraft: rows.length, degraded, share: rows.length ? degraded / rows.length : null, stale: Boolean(stale), error: null });
        } catch (e) {
          latest.set(r.id, { ...(latest.get(r.id) || {}), id: r.id, name: r.name, anchor, error: e?.message || 'failed' });
        }
        if (gapMs) await new Promise((ok) => setTimeout(ok, gapMs).unref?.());
      }
      lastRunAt = now();
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      setTimeout(runOnce, 20_000).unref?.();
      timer = setInterval(runOnce, REGION_POLL_MS);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    latest: () => regions.map((r) => latest.get(r.id) || { id: r.id, name: r.name, anchor: regionAnchor(r.box), aircraft: null, error: 'not read yet' }),
    status: () => ({ status: lastRunAt ? 'ok' : 'pending', lastRunAt, everyMs: REGION_POLL_MS, coverage: 'six 250 nm circles at the Blackout watch regions' }),
  };
}
