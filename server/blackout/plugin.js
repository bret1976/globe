import { shipFlagLog, shipWentDarkSnapshot, noteShipFeedStatus } from '../providers/vessels/went-dark.js';
import { ensureAisStreamForBlackout, aisStreamStatusForBlackout } from '../providers/vessels/ais-live.js';
import { blackoutStore } from './persist.js';
import { createMilAircraftWatcher } from './milAircraft.js';
import { createRegionPoller } from './regionPoller.js';
import { darkRow, toCsv, toGeoJson } from './export.js';

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

export function blackoutPlugin({ gnss = null, env = process.env, now = () => Date.now(), mil = null, regions = null } = {}) {
  const startedAt = now();
  let milWatcher = mil;
  let regionPoller = regions;
  let started = false;

  function startPollers() {
    if (started) return;
    started = true;
    if (!milWatcher) milWatcher = createMilAircraftWatcher();
    if (!regionPoller && gnss?.sample) regionPoller = createRegionPoller({ sample: gnss.sample });
    if (!blackoutPollersEnabled(env)) return;
    try { ensureAisStreamForBlackout(); } catch { /* reported in health */ }
    milWatcher.start();
    regionPoller?.start();
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
    const store = blackoutStore().status();
    const checks = {
      ships: { status: s.status, tracked: s.tracked ?? 0, steady: s.steady ?? 0, flagged: s.flagged?.length ?? 0, feed: shipStatus(), reason: s.reason ?? null },
      militaryAircraft: a ? { status: a.status, tracked: a.tracked ?? 0, steady: a.steady ?? 0, flagged: a.flagged?.length ?? 0, lastPollOkAt: a.lastPollOkAt, lastError: a.lastError, reason: a.reason ?? null } : { status: 'off' },
      gnssRegions: regionPoller ? regionPoller.status() : { status: 'off' },
      storage: store,
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function handler(req, res, next, base) {
    const url = new URL(req.url || '/', 'http://local');
    const path = (base + url.pathname).replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' }, undefined, { Allow: 'GET, OPTIONS' });
    startPollers();
    const t = now();
    try {
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
        const meta = { generatedAt: new Date(t).toISOString(), kind, window, provenance: 'inferred', attribution: [ATTRIBUTION.ships, ATTRIBUTION.aircraft], storage: blackoutStore().status().mode };
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
  };

  return {
    name: 'blackout',
    configureServer({ middlewares }) { install(middlewares); },
    configurePreviewServer({ middlewares }) { install(middlewares); startPollers(); },
    _health: health,
  };
}
