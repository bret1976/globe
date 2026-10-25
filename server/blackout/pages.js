import { csvCell, toGeoJson } from './export.js';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
export const HISTORY_COLUMNS = ['kind', 'id', 'label', 'state', 'lastSeenAt', 'flaggedAt', 'reappearedAt', 'darkMin', 'lat', 'lon', 'place', 'areas', 'speedMps', 'headingDeg', 'altitudeM', 'source'];

export function historyRow(h) {
  return {
    kind: h.kind, id: h.id, label: h.label, state: h.state,
    lastSeenAt: iso(h.lastSeenAt), flaggedAt: iso(h.flaggedAt), reappearedAt: iso(h.reappearedAt),
    darkMin: h.darkMin, lat: h.lat, lon: h.lon, place: h.place, areas: (h.areas || []).join(' '),
    speedMps: h.speedMps, headingDeg: h.headingDeg, altitudeM: h.altitudeM,
    source: h.kind === 'ship' ? 'AISStream' : 'adsb.lol /v2/mil',
  };
}
export function historyCsv(rows) {
  return [HISTORY_COLUMNS.join(','), ...rows.map((h) => { const r = historyRow(h); return HISTORY_COLUMNS.map((c) => csvCell(r[c])).join(','); })].join('\r\n') + '\r\n';
}
export function historyGeoJson(rows, meta = {}) {
  return toGeoJson(rows.map((h) => ({ ...historyRow(h), id: `${h.id}:${h.lastSeenAt}` })), meta);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Blackout</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05080d;color:#d8e6f0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:28rem;padding:2rem;border:1px solid #1c2a36;border-radius:12px;background:#0a1118;margin:1rem}h1{font-size:1.2rem;margin:0 0 .75rem;color:#00d4ff;letter-spacing:.04em}button{font:inherit;padding:.8rem 1.2rem;min-height:44px;border-radius:8px;border:1px solid #00d4ff;background:#00d4ff;color:#02141c;font-weight:600;cursor:pointer}a{color:#00d4ff}p{color:#9fb3c2}</style></head><body><main>${body}</main></body></html>`;

/** Small standalone pages for the alert links (no scripts). */
export function alertPage(kind, { token = '' } = {}) {
  if (kind === 'confirm') {
    return shell('Confirm alerts', `<h1>Confirm Blackout alerts</h1><p>Press the button to start receiving the alerts you asked for. (This extra step stops link scanners from confirming on your behalf.)</p><form method="post" action="/watch/alerts/confirm"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Confirm subscription</button></form>`);
  }
  if (kind === 'confirmed') return shell('Confirmed', '<h1>You’re subscribed</h1><p>Alerts arrive as a digest at most once an hour. Every mail has a one-click unsubscribe link.</p><p><a href="/watch">Back to Blackout</a></p>');
  if (kind === 'unsubscribed') return shell('Unsubscribed', '<h1>Unsubscribed</h1><p>This address will get no more Blackout mail, and its sign-up has been deleted.</p><p><a href="/watch">Back to Blackout</a></p>');
  return shell('Link expired', '<h1>That link has expired</h1><p>Confirmation links last 48 hours. You can sign up again on the page.</p><p><a href="/watch#alerts">Back to Blackout</a></p>');
}
