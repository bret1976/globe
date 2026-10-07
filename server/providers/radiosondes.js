/**
 * SondeHub live radiosonde (weather balloon) proxy (same-origin).
 *
 * Keyless community feed (CC BY-SA 2.0). One upstream request per TTL no
 * matter how many viewers, so the volunteer-run API sees a single polite
 * client. GET /api/radiosondes → { fetchedAt, source, attribution, license,
 * rawCount, count, rows }
 */
import { RADIOSONDES_URL, normalizeRadiosondes } from '../../src/layers/radiosondes/parse.js';

const TTL_MS = 2 * 60_000;
const STALE_MS = 30 * 60_000;
/** The whole planet is ~0.3 MB for 3 h; refuse anything absurd. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export function radiosondesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;

  async function refresh() {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchImpl(RADIOSONDES_URL, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'follow',
          headers: {
            Accept: 'application/json',
            'User-Agent':
              'GodsEyeView/0.1 (radiosondes proxy; +https://github.com/bret1976/globe)',
          },
        });
        if (!response.ok) throw new Error(`SondeHub HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
          throw new Error('SondeHub body exceeds size cap');
        const body = await response.json();
        const rawCount = Array.isArray(body)
          ? body.length
          : body && typeof body === 'object'
            ? Object.keys(body).length
            : 0;
        const rows = normalizeRadiosondes(body, { now: now() });
        if (!rows.length && rawCount) throw new Error('SondeHub returned no usable rows');
        const payload = {
          fetchedAt: now(),
          source: 'SondeHub',
          attribution: 'Radiosonde telemetry: SondeHub (sondehub.org) community receiver network',
          license: 'CC BY-SA 2.0',
          rawCount,
          count: rows.length,
          rows,
        };
        mem = { at: now(), payload };
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw lastError || new Error('SondeHub unavailable');
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/radiosondes', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      const send = (status, body, stale = false) => {
        if (res.headersSent || res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(stale ? { 'X-Data-Stale': 'true' } : {}),
        });
        res.end(JSON.stringify(body));
      };
      const t = now();
      if (mem && t - mem.at < TTL_MS) {
        send(200, mem.payload);
        return;
      }
      try {
        const run =
          inflight ||
          (inflight = refresh().finally(() => {
            inflight = null;
          }));
        const payload = await run;
        send(200, payload);
      } catch (error) {
        if (mem && t - mem.at < STALE_MS) {
          send(200, { ...mem.payload, stale: true }, true);
          return;
        }
        send(502, {
          error: error?.message || 'Radiosondes unavailable',
        });
      }
    });
  }

  return {
    name: 'local-radiosondes-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
