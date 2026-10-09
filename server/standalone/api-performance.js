/**
 * Hosted API performance: gzip for /api JSON and keep-warm for layer feeds.
 *
 * 1. Vite preview only compresses static assets — its compression middleware
 *    is installed AFTER plugin middlewares, so every /api/* layer payload went
 *    out raw (FIRMS ~39 MB, CCTV catalog ~2.9 MB, CelesTrak ~2.7 MB, AIS
 *    ~1.3 MB). On phones that read as a layer that "never loads". This
 *    middleware runs first and streams gzip for JSON/text API responses.
 * 2. Layer proxies cache upstream feeds for a few minutes. When a cache had
 *    expired, the next click waited on a cold Singapore → US upstream fetch
 *    (8–14 s for aurora, ionosphere, FAA TFRs, floods, earthquakes…). The
 *    keep-warm loop re-reads each feed through its own proxy on a timer, so
 *    upstream traffic stays at one fetch per proxy TTL while user clicks are
 *    served from a warm cache.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzipAsync = promisify(zlib.gzip);

const SKIP_COMPRESSION =
  /^\/api\/(cctv\/(frame|media)|realtime|voice\/(tts|command|asr)|radio\/click|tomtom\/flow)/;
const COMPRESSIBLE = /json|text|csv|xml|javascript|geo\+json/i;

export function createApiCompressionMiddleware({ threshold = 1024 } = {}) {
  return function apiCompression(req, res, next) {
    const url = String(req.url || '');
    if (!url.startsWith('/api/') || SKIP_COMPRESSION.test(url)) return next();
    if (req.method === 'HEAD') return next();
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || '')))
      return next();

    const write = res.write.bind(res);
    const end = res.end.bind(res);
    const writeHead = res.writeHead.bind(res);
    let decided = false;
    let gzip = null;

    const decide = (firstChunkLength) => {
      if (decided) return;
      decided = true;
      if (res.headersSent) return;
      const type = String(res.getHeader('content-type') || '');
      const encoding = res.getHeader('content-encoding');
      const declared = Number(res.getHeader('content-length'));
      const size = Number.isFinite(declared) ? declared : firstChunkLength;
      if (
        encoding ||
        !COMPRESSIBLE.test(type) ||
        /event-stream/i.test(type) ||
        res.statusCode === 204 ||
        res.statusCode === 304 ||
        (Number.isFinite(size) && size >= 0 && size < threshold)
      )
        return;
      res.removeHeader('content-length');
      res.setHeader('content-encoding', 'gzip');
      const vary = String(res.getHeader('vary') || '');
      if (!/accept-encoding/i.test(vary))
        res.setHeader(
          'vary',
          vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding',
        );
      gzip = zlib.createGzip({ level: 5 });
      gzip.on('data', (chunk) => write(chunk));
      gzip.on('end', () => end());
      gzip.on('error', () => end());
      res.on('close', () => {
        if (!res.writableEnded) gzip?.destroy();
      });
    };

    res.writeHead = function patchedWriteHead(status, reason, headers) {
      let headerObj = headers;
      let reasonText = reason;
      if (reason && typeof reason === 'object') {
        headerObj = reason;
        reasonText = undefined;
      }
      if (
        headerObj &&
        typeof headerObj === 'object' &&
        !Array.isArray(headerObj)
      ) {
        for (const [name, value] of Object.entries(headerObj)) {
          if (value !== undefined) res.setHeader(name, value);
        }
      }
      res.statusCode = status;
      // Decide before the head is flushed; unknown length → assume large.
      decide(Number.NaN);
      return typeof reasonText === 'string'
        ? writeHead(status, reasonText)
        : writeHead(status);
    };

    res.write = function patchedWrite(chunk, encoding, callback) {
      if (!decided) decide(Number.NaN);
      if (!gzip) return write(chunk, encoding, callback);
      return gzip.write(
        typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk,
        callback,
      );
    };

    res.end = function patchedEnd(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      if (!decided) {
        const length =
          chunk == null
            ? 0
            : typeof chunk === 'string'
              ? Buffer.byteLength(chunk, encoding)
              : chunk.length;
        decide(length);
      }
      if (!gzip) return end(chunk, encoding, callback);
      if (chunk != null)
        gzip.write(
          typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk,
        );
      if (typeof callback === 'function') res.once('finish', callback);
      gzip.end();
      return res;
    };

    next();
  };
}

export function apiCompressionPlugin() {
  // Block body on purpose: Vite calls any function a configurePreviewServer
  // hook returns as a post-hook, and connect's use() returns the app itself.
  const install = (server) => {
    server.middlewares.use(createApiCompressionMiddleware());
  };
  return {
    name: 'gev-api-compression',
    configureServer: install,
    configurePreviewServer: install,
  };
}

/** Layer feeds whose proxies cache upstream data; kept warm on a timer. */
export const KEEP_WARM_ENDPOINTS = Object.freeze([
  '/api/earthquakes',
  '/api/volcanoes',
  '/api/aurora',
  '/api/ionosphere',
  '/api/radiation',
  '/api/floods',
  '/api/usdm-drought',
  '/api/storm-reports',
  '/api/gpsjam',
  '/api/flight-restrictions',
  '/api/aviation-hazards',
  '/api/fireballs',
  '/api/nws-alerts',
  '/api/ndbc-buoys',
  '/api/usgs-gauges',
  '/api/tide-gauges',
  '/api/air-quality',
  '/api/ocean-currents',
  '/api/radiosondes',
  '/api/power-plants',
  '/api/wind',
  '/api/cyclones',
  '/api/fire-perimeters',
  '/api/au-fire',
  '/api/launches',
  '/api/ukraine-fires',
  '/api/firms',
  '/api/cctv/sources',
  '/api/celestrak/stations',
  '/api/celestrak/visual',
  '/api/celestrak/gps-ops',
  '/api/celestrak/glo-ops',
  '/api/celestrak/galileo',
  '/api/celestrak/geo',
  '/api/celestrak/starlink',
]);

/**
 * Stale-while-revalidate for the keep-warm layer feeds.
 *
 * Most proxies cache for 1–5 min but the keep-warm sweep runs every 4 min,
 * and an expired proxy cache makes the click wait on a cold Singapore → US
 * upstream fetch (5–13 s for radiosondes, tide gauges, air quality, military
 * aircraft…). That is the "sometimes it lags" Bret saw. This layer keeps the
 * last good 200 body of each feed (plus its gzip) and answers clicks from it
 * at once; when the copy is older than `refreshAfterMs` it re-reads the feed
 * through its own proxy in the background, so the proxies' upstream rates
 * and TTLs are unchanged. Copies older than `maxStaleMs` are never served.
 */
const SWR_BYPASS_HEADER = 'x-gev-swr-bypass';
const SWR_DEFAULTS = Object.freeze({
  refreshAfterMs: 30_000,
  maxStaleMs: 30 * 60_000,
});
export const SWR_ENDPOINTS = Object.freeze({
  ...Object.fromEntries(
    KEEP_WARM_ENDPOINTS.filter(
      // Own serialized caches already; a second copy would only cost memory.
      (endpoint) => !['/api/firms', '/api/ukraine-fires'].includes(endpoint),
    ).map((endpoint) => [endpoint, SWR_DEFAULTS]),
  ),
  // Radio directory (one global catalog; 5 s cold from Singapore).
  '/api/radio/stations': SWR_DEFAULTS,
  // Live aircraft: refresh on every poll, never serve a copy older than 5 min.
  '/api/adsblol/mil': Object.freeze({
    refreshAfterMs: 8_000,
    maxStaleMs: 5 * 60_000,
  }),
});
const SWR_KEEP_HEADERS = /^(content-type|x-[a-z0-9-]+)$/i;

export function createSwrStore({
  endpoints = SWR_ENDPOINTS,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const inflight = new Map();
  let base = null;
  const policy = (url) => {
    const raw = String(url || '');
    if (raw.includes('?')) return null;
    return Object.prototype.hasOwnProperty.call(endpoints, raw)
      ? endpoints[raw]
      : null;
  };
  async function refresh(url) {
    if (!base) return null;
    if (inflight.has(url)) return inflight.get(url);
    const job = (async () => {
      try {
        const response = await fetchImpl(`${base}${url}`, {
          headers: { 'accept-encoding': 'identity', [SWR_BYPASS_HEADER]: '1' },
          signal: AbortSignal.timeout(120_000),
        });
        const body = Buffer.from(await response.arrayBuffer());
        const type = String(response.headers.get('content-type') || '');
        if (response.status !== 200 || !/json/i.test(type) || !body.length)
          return null;
        const headers = {};
        for (const [name, value] of response.headers.entries()) {
          if (SWR_KEEP_HEADERS.test(name)) headers[name] = value;
        }
        const entry = {
          at: now(),
          headers,
          body,
          gz:
            body.length >= 1024
              ? gzipAsync(body, { level: 6 }).catch(() => null)
              : null,
        };
        entries.set(url, entry);
        return entry;
      } catch {
        return null;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, job);
    return job;
  }
  function middleware(req, res, next) {
    const url = String(req.originalUrl || req.url || '');
    const rule = req.method === 'GET' ? policy(url) : null;
    if (!rule || req.headers[SWR_BYPASS_HEADER]) return next();
    const entry = entries.get(url);
    const age = entry ? now() - entry.at : Infinity;
    if (!entry || age > rule.maxStaleMs) {
      // Normal path now; capture a copy for the next click from the
      // proxy's freshly warmed cache once this response is out.
      res.once('finish', () => void refresh(url));
      return next();
    }
    if (age > rule.refreshAfterMs) void refresh(url);
    const wantsGzip = /\bgzip\b/i.test(
      String(req.headers['accept-encoding'] || ''),
    );
    void Promise.resolve(wantsGzip && entry.gz ? entry.gz : null).then((gz) => {
      if (res.headersSent) return;
      const body = gz || entry.body;
      res.writeHead(200, {
        ...entry.headers,
        'cache-control': 'no-store',
        vary: 'Accept-Encoding',
        'x-gev-swr-age-ms': String(Math.max(0, age)),
        ...(gz ? { 'content-encoding': 'gzip' } : {}),
        'content-length': String(body.length),
      });
      res.end(body);
    });
  }
  return {
    middleware,
    refresh,
    has: (url) => entries.has(url),
    setBase(value) {
      base = value;
    },
    get size() {
      return entries.size;
    },
  };
}

const sharedSwrStore = createSwrStore();

export function apiSwrPlugin({ store = sharedSwrStore } = {}) {
  const install = (server) => {
    server.middlewares.use(store.middleware);
    const httpServer = server.httpServer;
    if (!httpServer) return;
    const setBase = () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (port) store.setBase(`http://127.0.0.1:${port}`);
    };
    if (httpServer.listening) setBase();
    else httpServer.once('listening', setBase);
  };
  return {
    name: 'gev-api-swr',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export function apiKeepWarmPlugin({
  endpoints = KEEP_WARM_ENDPOINTS,
  intervalMs = 4 * 60_000,
  initialDelayMs = 15_000,
  enabled = () =>
    process.env.GEV_KEEP_WARM === '1' ||
    (Boolean(process.env.RAILWAY_ENVIRONMENT) &&
      process.env.GEV_KEEP_WARM !== '0'),
  fetchImpl = (...args) => globalThis.fetch(...args),
  swrStore = endpoints === KEEP_WARM_ENDPOINTS ? sharedSwrStore : null,
  concurrency = 4,
} = {}) {
  let timer = null;
  let running = false;
  const install = (server) => {
    if (!enabled()) return;
    const httpServer = server.httpServer;
    if (!httpServer) return;
    const start = () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (!port) return;
      const base = `http://127.0.0.1:${port}`;
      const sweep = async () => {
        if (running) return;
        running = true;
        try {
          // A few at a time: one slow upstream no longer holds the rest of
          // the list cold for minutes after a deploy.
          const queue = [
            ...new Set([
              ...endpoints,
              ...(swrStore ? Object.keys(SWR_ENDPOINTS) : []),
            ]),
          ];
          const warmOne = async (endpoint) => {
            if (swrStore && Object.hasOwn(SWR_ENDPOINTS, endpoint)) {
              swrStore.setBase(base);
              await swrStore.refresh(endpoint);
              return;
            }
            try {
              const response = await fetchImpl(`${base}${endpoint}`, {
                headers: {
                  'accept-encoding': 'identity',
                  'x-gev-keep-warm': '1',
                },
                signal: AbortSignal.timeout(120_000),
              });
              await response.arrayBuffer().catch(() => null);
            } catch {
              /* the next sweep retries; user requests still work */
            }
          };
          const workers = Array.from(
            { length: Math.max(1, Math.min(concurrency, queue.length)) },
            async () => {
              while (queue.length) await warmOne(queue.shift());
            },
          );
          await Promise.all(workers);
        } finally {
          running = false;
        }
      };
      setTimeout(() => {
        void sweep();
        timer = setInterval(() => void sweep(), intervalMs);
        timer.unref?.();
      }, initialDelayMs).unref?.();
    };
    if (httpServer.listening) start();
    else httpServer.once('listening', start);
  };
  return {
    name: 'gev-api-keep-warm',
    configurePreviewServer: install,
    configureServer: install,
  };
}
