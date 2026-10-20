/**
 * NOAA Coral Reef Watch Regional Virtual Stations proxy (same-origin).
 *
 * Keyless CRW `vs_polygons.json` (U.S. Government work, public domain): daily
 * 5km bleaching heat-stress alert level, SST, SST anomaly, HotSpot and Degree
 * Heating Weeks for ~214 reef regions worldwide. The product updates once a
 * day and the upstream file is ~6 MB, so one refresh per 3 h regardless of
 * viewer count, retried with backoff, stale fallback for 48 h on outage.
 * GET /api/coral-bleaching → { fetchedAt, source, attribution, license, note,
 *   date, rawCount, count, levels, rows }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRW_VS_URL,
  CRW_ERDDAP_URL,
  CRW_OCEANWATCH_URLS,
  mergeCoralErddapCsvs,
  coralErddapPayload,
  normalizeCoralStations,
  countCoralLevels,
} from '../../src/layers/coralBleaching/parse.js';

export const CORAL_DISK_CACHE = join(
  process.env.GODSEYE_CACHE_DIR || tmpdir(),
  'godseye-coral-last-good.json',
);

const TTL_MS = 3 * 60 * 60_000;
const STALE_MS = 48 * 60 * 60_000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const BACKOFF_MS = [0, 3000];
const ERDDAP_BACKOFF_MS = [0, 5000];
const UA =
  'GodsEyeView/0.1 (coral-bleaching proxy; +https://github.com/bret1976/globe)';

export function coralBleachingProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  diskCache = null,
} = {}) {
  /** @type {?{at: number, payload: object}} */
  let mem = null;
  /** @type {?Promise<object>} */
  let inflight = null;
  /** Last good snapshot survives restarts (best effort, container disk). */
  let diskLoaded = !diskCache;
  async function loadDisk() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const saved = JSON.parse(await readFile(diskCache, 'utf8'));
      if (!mem && saved?.payload && Number.isFinite(saved.at)) mem = saved;
    } catch {
      /* no saved snapshot yet */
    }
  }
  function remember(payload) {
    mem = { at: now(), payload };
    if (diskCache) writeFile(diskCache, JSON.stringify(mem)).catch(() => {});
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(45_000),
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    if (!response.ok) throw new Error(`CRW HTTP ${response.status} for ${url}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
      throw new Error('CRW body exceeds size cap');
    return response.json();
  }

  async function fetchText(url, timeoutMs) {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'text/csv', 'User-Agent': UA },
    });
    if (!response.ok) throw new Error(`ERDDAP HTTP ${response.status}`);
    return response.text();
  }

  /** CRW mirrors in order: PacIOOS (one request), then PIFSC OceanWatch. */
  const MIRRORS = [
    {
      name: 'PacIOOS ERDDAP',
      load: () => fetchText(CRW_ERDDAP_URL, 45_000),
    },
    {
      name: 'NOAA PIFSC OceanWatch ERDDAP',
      load: async () =>
        mergeCoralErddapCsvs(
          await Promise.all(
            CRW_OCEANWATCH_URLS.map((url) => fetchText(url, 45_000)),
          ),
        ),
    },
  ];

  async function fetchErddap() {
    let lastError = null;
    for (const wait of ERDDAP_BACKOFF_MS) {
      if (wait) await sleep(wait);
      for (const mirror of MIRRORS) {
        try {
          const payload = coralErddapPayload(await mirror.load(), now());
          if (!payload.rows.length) throw new Error('no cells');
          return {
            ...payload,
            source: `NOAA Coral Reef Watch (${mirror.name})`,
            attribution: `Coral bleaching heat stress: NOAA Coral Reef Watch Daily 5km via ${mirror.name} (gridded fallback while coralreefwatch.noaa.gov is unreachable)`,
          };
        } catch (error) {
          lastError = error;
          console.warn(
            `[coral-bleaching] ${mirror.name} fallback failed:`,
            error?.cause?.code || error?.message || error,
          );
        }
      }
    }
    throw lastError || new Error('ERDDAP unavailable');
  }

  async function refresh() {
    let lastError = null;
    for (const wait of BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        const geojson = await fetchJson(CRW_VS_URL);
        const features = Array.isArray(geojson?.features)
          ? geojson.features
          : null;
        if (!features) throw new Error('CRW returned no features');
        const rows = normalizeCoralStations(geojson);
        if (!rows.length) throw new Error('CRW returned no usable stations');
        const dates = rows
          .map((r) => r.date)
          .filter(Boolean)
          .sort();
        const payload = {
          fetchedAt: now(),
          source: 'NOAA Coral Reef Watch',
          attribution:
            'Coral bleaching heat stress: NOAA Coral Reef Watch Daily 5km Regional Virtual Stations (coralreefwatch.noaa.gov)',
          license: 'U.S. Government work (public domain)',
          note: 'Satellite heat-stress outlook for reef regions (bleaching risk), not field-confirmed bleaching.',
          date: dates.length ? dates[dates.length - 1] : null,
          rawCount: features.length,
          count: rows.length,
          levels: countCoralLevels(rows),
          rows,
        };
        remember(payload);
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(
          '[coral-bleaching] upstream attempt failed:',
          error?.cause?.code || error?.message || error,
        );
      }
    }
    try {
      const payload = await fetchErddap();
      remember(payload);
      return payload;
    } catch (error) {
      throw lastError || error;
    }
  }

  function installMiddleware(server) {
    server.middlewares.use('/api/coral-bleaching', async (req, res, next) => {
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
      await loadDisk();
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
        send(200, await run);
      } catch (error) {
        if (mem && t - mem.at < STALE_MS) {
          send(200, { ...mem.payload, stale: true }, true);
          return;
        }
        send(502, { error: error?.message || 'Coral bleaching unavailable' });
      }
    });
  }

  return {
    name: 'local-coral-bleaching-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
