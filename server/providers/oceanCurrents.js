/**
 * Surface ocean currents proxy (same-origin) over Open-Meteo Marine.
 *
 * Keyless, CC BY 4.0. GET /api/ocean-currents →
 *   { fetchedAt, source, attribution, gridPoints, count, partial, rows }
 *
 * The free tier caps location-calls per minute, so the global 8° grid is
 * filled in spaced batches in the background and cached for 6 h. Requests
 * are served from cache (stale or partial) while a fill runs.
 */
import {
  OCEAN_CURRENTS_BATCH,
  OCEAN_CURRENTS_BATCH_GAP_MS,
  normalizeOceanCurrents,
  oceanCurrentsBatchUrl,
  oceanCurrentsGrid,
} from '../../src/layers/oceanCurrents/parse.js';

const TTL_MS = 6 * 60 * 60_000;
const RETRY_BACKOFF_MS = 10 * 60_000;
const WARM_DELAY_MS = 20_000;

export function oceanCurrentsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  gapMs = OCEAN_CURRENTS_BATCH_GAP_MS,
  warm = true,
} = {}) {
  const grid = oceanCurrentsGrid();
  /** @type {?{at: number, rows: object[], complete: boolean}} */
  let mem = null;
  /** @type {?{rows: object[]}} */
  let filling = null;
  let lastFailAt = 0;
  let lastError = null;

  async function fetchBatch(points) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(oceanCurrentsBatchUrl(points), {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'GodsEyeView/0.1 (ocean-currents proxy; +https://github.com/bret1976/globe)',
        },
      });
      if (response.status === 429) {
        await sleep(65_000);
        continue;
      }
      if (!response.ok)
        throw new Error(`Open-Meteo Marine HTTP ${response.status}`);
      return normalizeOceanCurrents(await response.json(), points);
    }
    throw new Error('Open-Meteo Marine rate limited');
  }

  async function fill() {
    if (filling) return;
    filling = { rows: [] };
    try {
      for (let i = 0; i < grid.length; i += OCEAN_CURRENTS_BATCH) {
        if (i > 0) await sleep(gapMs);
        const rows = await fetchBatch(grid.slice(i, i + OCEAN_CURRENTS_BATCH));
        filling.rows.push(...rows);
      }
      mem = { at: now(), rows: filling.rows, complete: true };
      lastError = null;
    } catch (error) {
      lastFailAt = now();
      lastError = error?.message || 'Ocean currents unavailable';
      console.warn('[ocean-currents] fill failed:', lastError);
      if (!mem && filling.rows.length)
        mem = { at: now(), rows: filling.rows, complete: false };
    } finally {
      filling = null;
    }
  }

  function maybeRefresh() {
    const t = now();
    if (filling) return;
    if (t - lastFailAt < RETRY_BACKOFF_MS) return;
    if (!mem || !mem.complete || t - mem.at >= TTL_MS) fill();
  }

  function snapshot() {
    const rows = mem?.rows?.length ? mem.rows : filling?.rows || [];
    const partial = !mem?.complete;
    return {
      fetchedAt: mem?.at ?? now(),
      source: 'Open-Meteo Marine',
      attribution:
        'Ocean currents: Open-Meteo Marine API (CC BY 4.0; Copernicus Marine / ECMWF ocean analyses)',
      gridPoints: grid.length,
      count: rows.length,
      partial,
      ...(mem && now() - mem.at >= TTL_MS ? { stale: true } : {}),
      rows,
    };
  }

  function installMiddleware(server) {
    if (warm) setTimeout(() => maybeRefresh(), WARM_DELAY_MS).unref?.();
    server.middlewares.use('/api/ocean-currents', (req, res, next) => {
      if (req.method !== 'GET') return next();
      maybeRefresh();
      const body = snapshot();
      if (!body.rows.length && !filling && lastError) {
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: lastError }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    });
  }

  return {
    name: 'local-ocean-currents-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
    _test: {
      fill,
      snapshot,
      get mem() {
        return mem;
      },
    },
  };
}
