import { shipFlagLog, shipWentDarkSnapshot, noteShipFeedStatus } from '../providers/vessels/went-dark.js';
import { ensureAisStreamForBlackout, aisStreamStatusForBlackout } from '../providers/vessels/ais-live.js';
import { blackoutStore } from './persist.js';
import { createMilAircraftWatcher } from './milAircraft.js';
import { createRegionPoller } from './regionPoller.js';
import { darkRow, toCsv, toGeoJson } from './export.js';
import { gzipSync } from 'node:zlib';
import { aisStreamRows, aisStreamVessel } from '../providers/vessels/ais-store.js';
import { createActivity } from './activity.js';
import { createAlerts } from './alerts.js';
import { createMailer } from './mailer.js';
import { createLive, parseBbox } from './live.js';
import { ALERT_AREAS, placeName } from './places.js';
const HISTORY_JSON_DEFAULT_LIMIT = 1000;
import { historyCsv, historyGeoJson, alertPage } from './pages.js';

export const TICK_MS = 30_000;
export const FLUSH_MS = 5 * 60_000;
const MAX_BODY = 4096;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseForm(raw, type = '') {
  if (/json/i.test(type)) { try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  const o = {}; for (const [k, v] of new URLSearchParams(raw)) { if (k in o) o[k] = [].concat(o[k], v); else o[k] = v; } return o;
}
const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
export function clientIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || '';
}
export function sameOrigin(req, publicUrl) {
  const origin = req.headers?.origin;
  if (!origin) return true; // non-browser clients; the other limits still apply
  try {
    const o = new URL(origin);
    if (o.host === req.headers?.host) return true;
    if (publicUrl && o.host === new URL(publicUrl).host) return true;
  } catch { /* fallthrough */ }
  return false;
}
export function publicUrlFrom(env = process.env) {
  if (env.BLACKOUT_PUBLIC_URL) return String(env.BLACKOUT_PUBLIC_URL).replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return '';
}

const ATTRIBUTION = {
  ships: 'AIS positions: AISStream.io',
  aircraft: 'Military ADS-B: adsb.lol (ODbL 1.0)',
  gnss: 'GNSS integrity: adsb.lol (ODbL 1.0); daily jamming: GPSJam.org',
};

/** Pollers run only on the real hosted server (or when asked) — never in tests. */
export function blackoutPollersEnabled(env = process.env) {
  const raw = String(env.BLACKOUT_POLLERS ?? '').trim().toLowerCase();
  if (raw) return !['0', 'false', 'off', 'no'].includes(raw);
  return env.NODE_ENV === 'production' || Boolean(env.RAILWAY_PROJECT_ID);
}

export function blackoutPlugin({ gnss = null, env = process.env, now = () => Date.now(), mil = null, regions = null, store = null, mailer = null, shipRowsImpl = null, shipVesselImpl = null } = {}) {
  const startedAt = now();
  let milWatcher = mil;
  let regionPoller = regions;
  let started = false;
  let timers = [];
  const st = () => store || blackoutStore();
  let activity = null;
  let alerts = null;
  let live = null;
  let lastTickAt = -Infinity;
  const publicUrl = publicUrlFrom(env);

  function ensureCore() {
    if (activity) return;
    if (!milWatcher) milWatcher = createMilAircraftWatcher();
    if (!regionPoller && gnss?.sample) regionPoller = createRegionPoller({ sample: gnss.sample });
    activity = createActivity({
      store: st(), now,
      sources: {
        shipFlags: (t) => { ships(t); return shipFlagLog().list(t); },
        milFlags: (t) => milWatcher?.recent(t) || [],
        regions: () => regionPoller?.latest() || [],
      },
    });
    alerts = createAlerts({ store: st(), mailer: mailer || createMailer({ env }), now, publicUrl, env });
    activity.onEvent((ev) => alerts.onEvent(ev, now()));
    live = createLive({
      now,
      shipRows: () => (shipRowsImpl || aisStreamRows)(50_000),
      aircraft: () => milWatcher?.positions?.() || { list: [] },
      dark: (t) => darkRows('all', 'live', t).map((r) => ({ ...r, place: placeName(r.lat, r.lon) })),
    });
  }
  function maybeTick(t) {
    ensureCore();
    if (t - lastTickAt < TICK_MS) return;
    lastTickAt = t;
    activity.tick(t);
  }

  function startPollers() {
    if (started) return;
    started = true;
    ensureCore();
    if (!blackoutPollersEnabled(env)) return;
    try { ensureAisStreamForBlackout(); } catch { /* reported in health */ }
    milWatcher.start();
    regionPoller?.start();
    // Server-side detector tick: the event feed, history and alerts must
    // advance even when nobody has the page open.
    const tk = setInterval(() => { try { maybeTick(now()); } catch { /* next tick */ } }, TICK_MS);
    const fl = setInterval(() => { alerts.flush(now()).catch(() => {}); }, FLUSH_MS);
    tk.unref?.(); fl.unref?.();
    timers = [tk, fl];
  }

  const shipStatus = () => {
    try { return aisStreamStatusForBlackout()?.status || 'unknown'; } catch { return 'unknown'; }
  };

  function ships(t) {
    noteShipFeedStatus(shipStatus(), t);
    return shipWentDarkSnapshot(t);
  }

  function darkRows(kind, window, t) {
    const rows = [];
    if (kind !== 'aircraft') {
      const snap = ships(t);
      const list = window === '24h' ? shipFlagLog().list(t) : snap.flagged || [];
      for (const f of list) rows.push(darkRow(f, { kind: 'ship', source: 'AISStream', nowMs: t }));
    }
    if (kind !== 'ships' && milWatcher) {
      const snap = milWatcher.snapshot(t);
      const list = window === '24h' ? milWatcher.recent(t) : snap.flagged || [];
      for (const f of list) rows.push(darkRow(f, { kind: 'military-aircraft', source: 'adsb.lol /v2/mil', nowMs: t }));
    }
    return rows;
  }

  function health(t) {
    const s = ships(t);
    const a = milWatcher ? milWatcher.snapshot(t) : null;
    const store = st().status();
    const checks = {
      ships: { status: s.status, tracked: s.tracked ?? 0, steady: s.steady ?? 0, flagged: s.flagged?.length ?? 0, feed: shipStatus(), reason: s.reason ?? null, candidates: s.candidates ?? null, lastDegradedAt: s.lastDegradedAt ?? null },
      militaryAircraft: a ? { status: a.status, tracked: a.tracked ?? 0, steady: a.steady ?? 0, flagged: a.flagged?.length ?? 0, lastPollOkAt: a.lastPollOkAt, lastError: a.lastError, reason: a.reason ?? null } : { status: 'off' },
      gnssRegions: regionPoller ? regionPoller.status() : { status: 'off' },
      storage: store,
      activity: activity ? activity.status() : { status: 'off' },
      alerts: alerts ? alerts.status() : { status: 'off' },
    };
    const ok = ['ok', 'partial'];
    const live = ok.includes(checks.ships.status) || ok.includes(checks.militaryAircraft.status);
    return {
      status: live ? (ok.includes(checks.ships.status) && ok.includes(checks.militaryAircraft.status) ? 'ok' : 'degraded') : 'down',
      service: 'blackout',
      generatedAt: new Date(t).toISOString(),
      uptimeS: Math.round((t - startedAt) / 1000),
      pollers: blackoutPollersEnabled(env) ? 'on' : 'off',
      commit: (env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      checks,
    };
  }

  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }

  async function handler(req, res, next, base) {
    const url = new URL(req.url || '/', 'http://local');
    const path = (base + url.pathname).replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const postable = ['/api/blackout/v1/alerts/subscribe', '/watch/alerts/confirm', '/watch/alerts/unsubscribe'].includes(path);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && postable)) return send(res, 405, { error: 'method_not_allowed' }, undefined, { Allow: 'GET, OPTIONS' });
    startPollers();
    const t = now();
    try {
      maybeTick(t);
      const html = (status, body) => send(res, status, body, 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': 'null' });
      const json = (status, body) => {
        const raw = JSON.stringify(body);
        if (raw.length > 8192 && /\bgzip\b/.test(String(req.headers?.['accept-encoding'] || ''))) return send(res, status, gzipSync(raw), 'application/json; charset=utf-8', { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
        return send(res, status, raw);
      };
      if (path === '/api/blackout/v1/live') {
        const kinds = listOf(url.searchParams.get('kinds') || 'ships,aircraft,dark');
        return json(200, live.payload({ kinds, bbox: parseBbox(url.searchParams.get('bbox')), grid: Number(url.searchParams.get('grid')) || 0 }, t));
      }
      if (path === '/api/blackout/v1/target') {
        const kind = url.searchParams.get('kind');
        const id = String(url.searchParams.get('id') || '').slice(0, 20);
        const hist = activity.historyList({ q: id, kind: kind === 'ship' ? 'ship' : 'military-aircraft', limit: 10 }, t).rows.filter((h) => h.id === id);
        if (kind === 'ship') {
          const v = (shipVesselImpl || aisStreamVessel)(id);
          return json(v || hist.length ? 200 : 404, { kind, id, provenance: 'observed', vessel: v, place: v ? placeName(Number(v.lat), Number(v.lon)) : null, history: hist, source: 'AISStream.io' });
        }
        if (kind === 'aircraft') {
          const a = (milWatcher?.positions?.().list || []).find((x) => String(x.id) === id) || null;
          return json(a || hist.length ? 200 : 404, { kind, id, provenance: 'observed', aircraft: a, place: a ? placeName(a.lat, a.lon) : null, history: hist, source: 'adsb.lol /v2/mil (ODbL 1.0)' });
        }
        return send(res, 400, { error: 'invalid_kind', allowed: ['ship', 'aircraft'] });
      }
      if (path === '/api/blackout/v1/events/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
        const since = req.headers['last-event-id'] || url.searchParams.get('since');
        const write = (ev) => res.write(`id: ${ev.id}\nevent: activity\ndata: ${JSON.stringify(ev)}\n\n`);
        res.write('retry: 5000\n\n');
        if (since) for (const ev of activity.list({ since, limit: 200 }).reverse()) write(ev);
        const off = activity.onEvent(write);
        const hb = setInterval(() => { try { maybeTick(now()); res.write(`: hb ${Date.now()}\n\n`); } catch { /* closed */ } }, 15_000);
        const cap = setTimeout(() => res.end(), 10 * 60_000); // clients reconnect; keeps proxies happy
        req.on('close', () => { off(); clearInterval(hb); clearTimeout(cap); });
        return undefined;
      }
      if (path === '/api/blackout/v1/events') {
        const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 200);
        const list = activity.list({ since: url.searchParams.get('since'), limit, type: url.searchParams.get('type') || null, kind: url.searchParams.get('kind') || null });
        return json(200, { generatedAt: new Date(t).toISOString(), provenance: 'inferred', status: activity.status(), count: list.length, events: list, attribution: ATTRIBUTION });
      }
      if (path === '/api/blackout/v1/history') {
        const p = url.searchParams;
        const kindQ = p.get('kind') || 'all';
        const kind = { all: null, ships: 'ship', ship: 'ship', aircraft: 'military-aircraft' }[kindQ];
        if (kind === undefined) return send(res, 400, { error: 'invalid_kind', allowed: ['all', 'ships', 'aircraft'] });
        const state = p.get('state') || 'all';
        if (!['all', 'dark', 'reappeared'].includes(state)) return send(res, 400, { error: 'invalid_state', allowed: ['all', 'dark', 'reappeared'] });
        const area = p.get('area') || null;
        if (area && !ALERT_AREAS.some((a) => a.id === area)) return send(res, 400, { error: 'invalid_area', allowed: ALERT_AREAS.map((a) => a.id) });
        const format = p.get('format') || 'json';
        if (!['json', 'csv', 'geojson'].includes(format)) return send(res, 400, { error: 'invalid_format', allowed: ['json', 'csv', 'geojson'] });
        const days = Number(p.get('days'));
        const out = activity.historyList({ kind, state: state === 'all' ? null : state, area, q: String(p.get('q') || '').slice(0, 60), sinceMs: days > 0 ? t - days * 86_400_000 : null, limit: Number(p.get('limit')) || (format === 'json' ? HISTORY_JSON_DEFAULT_LIMIT : 20_000), offset: Number(p.get('offset')) || 0 }, t);
        const stamp = new Date(t).toISOString().replace(/[:.]/g, '-');
        const meta = { generatedAt: new Date(t).toISOString(), provenance: 'inferred', retentionDays: 90, attribution: [ATTRIBUTION.ships, ATTRIBUTION.aircraft] };
        if (format === 'csv') return send(res, 200, historyCsv(out.rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="blackout-disappearances-${stamp}.csv"` });
        if (format === 'geojson') return send(res, 200, historyGeoJson(out.rows, meta), 'application/geo+json; charset=utf-8', { 'Content-Disposition': `attachment; filename="blackout-disappearances-${stamp}.geojson"` });
        const nextOffset = out.offset + out.rows.length < out.total ? out.offset + out.rows.length : null;
        return json(200, { ...meta, total: out.total, count: out.rows.length, offset: out.offset, nextOffset, rows: out.rows, areas: ALERT_AREAS.map(({ id, name }) => ({ id, name })) });
      }
      if (path === '/api/blackout/v1/alerts') {
        const s = alerts.status();
        return send(res, 200, { mail: { mode: s.mail.mode, reason: s.mail.reason }, throttle: s.throttle, areas: ALERT_AREAS.map(({ id, name }) => ({ id, name })), types: ['ship', 'aircraft', 'gnss', 'reappeared'] });
      }
      if (path === '/api/blackout/v1/alerts/subscribe') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, undefined, { Allow: 'POST' });
        if (!sameOrigin(req, publicUrl)) return send(res, 403, { ok: false, error: 'cross_origin' });
        let body;
        try { body = parseForm(await readBody(req), req.headers['content-type']); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? 'too_large' : 'bad_body' }); }
        const r = await alerts.subscribe({ email: body.email, areas: listOf(body.areas), types: listOf(body.types), honeypot: body.website || '', ip: clientIp(req) }, t);
        return send(res, r.ok ? 200 : r.error === 'rate_limited' ? 429 : r.error === 'full' ? 503 : 400, r);
      }
      if (path === '/watch/alerts/confirm') {
        const tok = url.searchParams.get('t') || '';
        if (req.method === 'POST') {
          let body = {};
          try { body = parseForm(await readBody(req), req.headers['content-type']); } catch { /* use query */ }
          const r = alerts.confirm(String(body.t || tok), t);
          return html(r.ok ? 200 : 404, alertPage(r.ok ? 'confirmed' : 'expired'));
        }
        return html(200, alertPage('confirm', { token: tok }));
      }
      if (path === '/watch/alerts/unsubscribe') {
        let tok = url.searchParams.get('t') || '';
        if (req.method === 'POST' && !tok) { try { tok = String(parseForm(await readBody(req), req.headers['content-type']).t || ''); } catch { /* ignore */ } }
        alerts.unsubscribe(tok);
        return html(200, alertPage('unsubscribed'));
      }
      if (path === '/watch/health' || path === '/api/blackout/v1/health') {
        const h = health(t);
        return send(res, h.status === 'down' ? 503 : 200, h);
      }
      if (path === '/api/blackout/v1/dark') {
        const kind = url.searchParams.get('kind') || 'all';
        const window = url.searchParams.get('window') || 'live';
        const format = url.searchParams.get('format') || 'json';
        if (!['all', 'ships', 'aircraft'].includes(kind)) return send(res, 400, { error: 'invalid_kind', allowed: ['all', 'ships', 'aircraft'] });
        if (!['live', '24h'].includes(window)) return send(res, 400, { error: 'invalid_window', allowed: ['live', '24h'] });
        if (!['json', 'csv', 'geojson'].includes(format)) return send(res, 400, { error: 'invalid_format', allowed: ['json', 'csv', 'geojson'] });
        const rows = darkRows(kind, window, t);
        const stamp = new Date(t).toISOString().replace(/[:.]/g, '-');
        const meta = { generatedAt: new Date(t).toISOString(), kind, window, provenance: 'inferred', attribution: [ATTRIBUTION.ships, ATTRIBUTION.aircraft], storage: st().status().mode };
        if (format === 'csv') return send(res, 200, toCsv(rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="blackout-went-dark-${window}-${stamp}.csv"` });
        if (format === 'geojson') return send(res, 200, toGeoJson(rows, meta), 'application/geo+json; charset=utf-8', { 'Content-Disposition': `attachment; filename="blackout-went-dark-${window}-${stamp}.geojson"` });
        return send(res, 200, { ...meta, count: rows.length, rows });
      }
      if (path === '/api/blackout/v1/aircraft') return send(res, 200, milWatcher.snapshot(t));
      if (path === '/api/blackout/v1/regions') return send(res, 200, regionPoller ? { ...regionPoller.status(), regions: regionPoller.latest() } : { status: 'off', regions: [] });
      if (path === '/api/blackout/v1' || path === '/api/blackout') {
        return send(res, 200, {
          service: 'blackout', version: 1, readOnly: true, auth: 'none',
          endpoints: {
            'GET /api/blackout/v1/health': 'Feed, detector and storage status (503 when nothing is live).',
            'GET /api/blackout/v1/dark?kind=all|ships|aircraft&window=live|24h&format=json|csv|geojson': 'Went-dark list.',
            'GET /api/blackout/v1/aircraft': 'Military-aircraft detector snapshot.',
            'GET /api/blackout/v1/regions': 'Latest GNSS-integrity read per watched region.',
            'GET /api/blackout/v1/live?kinds=ships,aircraft,dark&bbox=w,s,e,n&grid=deg': 'Live map positions (ships grid-thinned) and current went-dark targets.',
            'GET /api/blackout/v1/target?kind=ship|aircraft&id=': 'Details for one target.',
            'GET /api/blackout/v1/events?since=id': 'Activity feed (went dark, reappeared, GPS interference rose). SSE: /events/stream.',
            'GET /api/blackout/v1/history?kind=&state=&area=&q=&days=&limit=&offset=&format=json|csv|geojson': 'Disappearance history (90 days). JSON returns up to 1000 rows by default; page with limit/offset (nextOffset).',
            'POST /api/blackout/v1/alerts/subscribe': 'Email-alert sign-up (double opt-in).',
            'GET /api/gnss-integrity/history': '24 h GNSS-integrity frames (?at=ms for one frame).',
            'GET /api/gpsjam/dates': 'Daily GPSJam dates (?date=YYYY-MM-DD for one day).',
          },
          attribution: ATTRIBUTION,
        });
      }
      return send(res, 404, { error: 'unknown_route' });
    } catch (e) {
      return send(res, 500, { error: 'blackout_error', message: String(e?.message || e).slice(0, 200) });
    }
  }

  const install = (middlewares) => {
    middlewares.use('/api/blackout', (req, res, next) => handler(req, res, next, '/api/blackout'));
    middlewares.use('/watch/health', (req, res, next) => handler(req, res, next, '/watch/health'));
    middlewares.use('/watch/alerts', (req, res, next) => handler(req, res, next, '/watch/alerts'));
  };

  return {
    name: 'blackout',
    configureServer({ middlewares }) { install(middlewares); },
    configurePreviewServer({ middlewares }) { install(middlewares); startPollers(); },
    _health: health,
    _core: () => { ensureCore(); return { activity, alerts, live }; },
    _stop: () => { timers.forEach(clearInterval); milWatcher?.stop?.(); regionPoller?.stop?.(); },
  };
}
