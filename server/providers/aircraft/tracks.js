import { getOpenSkyToken } from './opensky.js';
import { readCappedResponseText } from '../common/http.js';
/**
 * Vite plugin: aircraft track-history backfill proxies (PRD WS-F F1/F2).
 *
 * /api/opensky-track?icao24=<hex6> — OpenSky GET /tracks/all (experimental;
 *   own credit bucket, 4 credits per call on the free tier). OAuth via the
 *   shared coalesced token. 60s per-icao cache on success; one retry on
 *   timeout/429/5xx; failures are cached 5 min and three in a row pause
 *   upstream calls for 10 min. Any failure answers 200 with an empty path
 *   and a friendly message so the client keeps its own recorded trail.
 * /api/adsblol/trace?hex=<hex> — compatibility refusal for the retired,
 *   undocumented ADSB.lol trace route. The standalone military source uses
 *   locally accumulated trails; provider-supplied history remains optional.
 */
export function trackBackfillProxies() {
  const TRACK_CACHE_MS = 60000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  /** @type {Map<string, {at:number,ttl:number,body?:string,fallback?:string}>} */
  const cache = new Map();

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  const FAIL_CACHE_MS = 5 * 60000;
  const BREAKER_MS = 10 * 60000;
  const BREAKER_THRESHOLD = 3;
  let consecutiveFailures = 0;
  let breakerUntil = 0;

  const FALLBACK_MESSAGE =
    'Flight history is temporarily unavailable; showing the path recorded since you started watching.';

  function sendFallback(res, icao24, reason) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Track-Source', 'local-trail');
    res.setHeader('X-Track-Fallback', reason);
    res.end(
      JSON.stringify({
        icao24,
        path: [],
        fallback: 'local-trail',
        reason,
        message: FALLBACK_MESSAGE,
      }),
    );
  }

  /** One upstream attempt; resolves {status,text} or throws on network/timeout. */
  async function fetchOnce(url, headers, timeoutMs) {
    const upstream = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { tooLarge, text } = await readCappedResponseText(
      upstream,
      RESPONSE_CAP_BYTES,
    );
    return { status: tooLarge ? 413 : upstream.status, ok: upstream.ok && !tooLarge, text };
  }

  async function openSkyTrack(res, icao24) {
    const key = `osky:${icao24}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) {
      if (cached.fallback) return sendFallback(res, icao24, cached.fallback);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Track-Source', 'opensky');
      res.setHeader('X-Track-Cache', 'HIT');
      res.end(cached.body);
      return;
    }
    if (Date.now() < breakerUntil) return sendFallback(res, icao24, 'upstream_paused');

    let token = null;
    try {
      token = await getOpenSkyToken();
    } catch {
      token = null;
    }
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const url = `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`;
    let result = null;
    // Worst case (two timeouts + backoff) stays ~6.8s, inside the client's
    // 8s backfill abort, so the friendly fallback always reaches the browser.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await fetchOnce(url, headers, attempt === 0 ? 3500 : 3000);
      } catch {
        result = null; // network error / timeout (OpenSky often drops cloud IPs)
      }
      const retryable = !result || result.status === 429 || result.status >= 500;
      if (!retryable) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
    }

    if (result?.ok) {
      consecutiveFailures = 0;
      cachePut(key, { at: Date.now(), ttl: TRACK_CACHE_MS, body: result.text });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Track-Source', 'opensky');
      res.setHeader('X-Track-Cache', 'MISS');
      res.end(result.text);
      return;
    }
    const reason = !result
      ? 'unreachable'
      : result.status === 404
        ? 'no_history'
        : result.status === 429
          ? 'rate_limited'
          : `http_${result.status}`;
    // A 404 is a real answer about this aircraft, not an outage.
    if (reason !== 'no_history' && ++consecutiveFailures >= BREAKER_THRESHOLD) {
      breakerUntil = Date.now() + BREAKER_MS;
      consecutiveFailures = 0;
    }
    cachePut(key, { at: Date.now(), ttl: FAIL_CACHE_MS, fallback: reason });
    sendFallback(res, icao24, reason);
  }

  function install(middlewares) {
    middlewares.use('/api/opensky-track', async (req, res) => {
      const incoming = new URL(req.url || '', 'http://localhost');
      const icao24 = String(incoming.searchParams.get('icao24') || '')
        .trim()
        .toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(icao24)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'icao24 must be a 6-char hex string' }));
        return;
      }
      try {
        await openSkyTrack(res, icao24);
      } catch {
        // Never surface a hard error for an optional history backfill: the
        // client keeps drawing the path from the positions it recorded itself.
        sendFallback(res, icao24, 'error');
      }
    });

    middlewares.use('/api/adsblol/trace', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const hex = String(incoming.searchParams.get('hex') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ error: 'hex must be a 6-7 char hex string' }),
          );
          return;
        }
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '1800');
        res.end(
          JSON.stringify({
            error:
              'Military history unavailable; locally accumulated trails remain available',
            code: 'history_unavailable',
          }),
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'adsb.lol trace fetch failed' }));
      }
    });
  }

  return {
    name: 'track-backfill-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
