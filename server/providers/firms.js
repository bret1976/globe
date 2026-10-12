import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) plus MODIS_NRT (combined Terra+Aqua,
 * ~1 km, numeric 0-100 confidence), fetched sequentially (quota courtesy)
 * with `days=2` (`days=1` means "current UTC day", nearly empty just after
 * 00:00Z) and clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS
 * quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): /api/firms → 503 {error:'no_key'}; status →
 * {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function firmsProxy() {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = [
    'VIIRS_NOAA20_NRT',
    'VIIRS_NOAA21_NRT',
    'VIIRS_SNPP_NRT',
    'MODIS_NRT',
  ];
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** @type {?{at: number, sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, sources: Array<object>, fires: Array<object>}>} single-flight refresh */
  let inflight = null;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  // The world payload is ~27 MB of JSON (~135K fires). Re-filtering,
  // stringifying and gzipping it on every request held the event loop for
  // seconds, so every other layer click queued behind it (and the keep-warm
  // sweep re-paid it every 4 min). Serialize once per cache entry/staleness,
  // re-filter the trailing 24 h at most once a minute, and keep the gzip.
  const SERIALIZED_TTL_MS = 60_000;
  const gzipAsync = promisify(zlib.gzip);
  /** One memo per requested limit (full payload = key 0). */
  const serializedByLimit = new Map();
  function serializedPayload(entry, stale, limit = null) {
    const now = Date.now();
    const key = limit || 0;
    const serialized = serializedByLimit.get(key);
    if (
      serialized &&
      serialized.entry === entry &&
      serialized.stale === stale &&
      now - serialized.at < SERIALIZED_TTL_MS
    )
      return serialized;
    const json = Buffer.from(
      JSON.stringify(buildPayload(entry, stale, limit)),
    );
    const gz = gzipAsync(json, { level: 6 }).catch(() => null);
    const next = { entry, stale, at: now, json, gz };
    serializedByLimit.set(key, next);
    return next;
  }
  /** `?limit=` accepted only as an integer 1000..200000; anything else = full. */
  function requestedLimit(req) {
    try {
      const raw = new URL(req.url || '/', 'http://x').searchParams.get('limit');
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isInteger(n) && n >= 1000 && n <= 200_000 ? n : null;
    } catch {
      return null;
    }
  }
  async function sendPayload(req, res, entry, stale) {
    const out = serializedPayload(entry, stale, requestedLimit(req));
    const wantsGzip = /\bgzip\b/i.test(
      String(req.headers?.['accept-encoding'] || ''),
    );
    const gz = wantsGzip ? await out.gz : null;
    if (res.headersSent) return;
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
    };
    if (gz) headers['Content-Encoding'] = 'gzip';
    const body = gz || out.json;
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
      ) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Never log the URL —
   * it embeds the MAP_KEY.
   */
  async function fetchSource(key, source) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(await res.text());
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(await fetchSource(key, source), now);
        // NOT fires.push(...records): spread passes each record as an argument,
        // and a world/2 VIIRS pull exceeds V8's argument limit (~125k) at
        // ~131k records — RangeError, and the whole source is silently dropped.
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${source} fetch failed:`,
          err?.message || err,
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale, limit = null) {
    let fires = filterTrailing24h(entry.fires, Date.now());
    const totalCount = fires.length;
    // Phone-lite (`?limit=N`): keep the N most intense detections (highest
    // FRP) so a phone never parses ~180K records. Same shape, fewer rows.
    if (limit && fires.length > limit) {
      fires = [...fires]
        .sort((a, b) => (Number(b.frp) || 0) - (Number(a.frp) || 0))
        .slice(0, limit);
    }
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: fires.length,
      ...(fires.length < totalCount ? { totalCount, limited: true } : {}),
      fires,
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit)
            ? { used, limit }
            : null;
        } catch (err) {
          console.warn(
            '[firms-proxy] mapkey status failed:',
            err?.message || err,
          );
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => {
          statusInflight = null;
        });
    }
    return statusInflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/firms', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const subPath = String(req.url || '').split('?')[0];
        const key = mapKey();
        await readDiskOnce();

        if (subPath === '/status') {
          if (!key) {
            sendJson(200, {
              hasKey: false,
              lastFetch: null,
              count: null,
              stale: false,
              ttlMs: TTL_MS,
              transactions: null,
            });
            return;
          }
          const transactions = await getTransactions(key);
          sendJson(200, {
            hasKey: true,
            lastFetch: mem ? mem.at : null,
            count: mem ? mem.fires.length : null,
            stale: mem ? Date.now() - mem.at >= TTL_MS : false,
            ttlMs: TTL_MS,
            transactions,
          });
          return;
        }

        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = mem;
        if (entry && Date.now() - entry.at < TTL_MS) {
          await sendPayload(req, res, entry, false);
          return;
        }
        // Stale or missing → refresh in the background. The first fill of
        // three VIIRS world feeds is ~30s; blocking the HUD on that is why
        // DATA LAYERS looked dead after a Railway cold start.
        if (!inflight) {
          inflight = refreshUpstream(key)
            .then(async (fresh) => {
              mem = fresh;
              await writeDisk(fresh);
              return fresh;
            })
            .catch((err) => {
              console.warn(
                `[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        if (entry) {
          await sendPayload(req, res, entry, true);
          return;
        }
        sendJson(200, {
          fetchedAt: null,
          stale: false,
          warming: true,
          ttlMs: TTL_MS,
          sources: [],
          count: 0,
          fires: [],
        });
      } catch (err) {
        console.warn('[firms-proxy] error:', err?.message || err);
        sendJson(500, { error: 'firms proxy error' });
      }
    });
  };
  function prefetch() {
    const key = mapKey();
    if (!key) return;
    void readDiskOnce().then(() => {
      if (mem && Date.now() - mem.at < TTL_MS) return;
      if (inflight) return;
      inflight = refreshUpstream(key)
        .then(async (fresh) => {
          mem = fresh;
          await writeDisk(fresh);
          return fresh;
        })
        .catch((err) => {
          console.warn(
            `[firms-proxy] prefetch failed (${err?.message || err})`,
          );
          return null;
        })
        .finally(() => {
          inflight = null;
        });
    });
  }

  return {
    name: 'firms-proxy',
    configureServer(server) {
      prefetch();
      installMiddleware(server);
    },
    configurePreviewServer(server) {
      prefetch();
      installMiddleware(server);
    },
  };
}
