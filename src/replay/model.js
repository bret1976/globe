/**
 * Pure helpers for the replay feature (no Cesium) so they can be unit tested.
 */
export const REPLAY_SPEEDS = [1, 3, 10, 60, 300];
export const MAX_GAP_S = 120; // never interpolate across a longer receiver gap

/** Split a track's points into contiguous segments (gap > MAX_GAP_S). */
export function splitSegments(pts, maxGap = MAX_GAP_S) {
  const segs = [];
  let cur = [];
  for (const p of pts) {
    if (cur.length && p[0] - cur[cur.length - 1][0] > maxGap) {
      if (cur.length) segs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

export function parseReplayHash(hash = '') {
  const m = /(?:^#|[#&])replay(?:=([^&]*))?/.exec(hash);
  if (!m) return null;
  return decodeURIComponent(m[1] || '') || 'default';
}

/** Clamp a view rectangle (degrees) to the server's max span, keeping centre. */
export function clampBbox([w, s, e, n], maxSpan = 2.5) {
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const hw = Math.min((e - w) / 2, maxSpan / 2 - 0.005), hh = Math.min((n - s) / 2, maxSpan / 2 - 0.005);
  const r = (x) => Math.round(x * 100) / 100;
  return [r(cx - hw), r(Math.max(-84, cy - hh)), r(cx + hw), r(Math.min(84, cy + hh))];
}

export function formatClock(epochS, timeZone) {
  const d = new Date(epochS * 1000);
  const opts = { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
  try { return d.toLocaleTimeString('en-US', { ...opts, timeZone }); } catch { return d.toLocaleTimeString('en-US', opts); }
}

export function formatDate(epochS, timeZone) {
  const d = new Date(epochS * 1000);
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  try { return d.toLocaleDateString('en-US', { ...opts, timeZone }); } catch { return d.toLocaleDateString('en-US', opts); }
}

export function speedLabel(x) { return `${x} s/s`; }
