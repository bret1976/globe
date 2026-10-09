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
import zlib from 'node:zlib';

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

export function apiKeepWarmPlugin({
  endpoints = KEEP_WARM_ENDPOINTS,
  intervalMs = 4 * 60_000,
  initialDelayMs = 15_000,
  enabled = () =>
    process.env.GEV_KEEP_WARM === '1' ||
    (Boolean(process.env.RAILWAY_ENVIRONMENT) &&
      process.env.GEV_KEEP_WARM !== '0'),
  fetchImpl = (...args) => globalThis.fetch(...args),
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
          for (const endpoint of endpoints) {
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
          }
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
