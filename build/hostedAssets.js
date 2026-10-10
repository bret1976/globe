/**
 * Production preview middleware: gzip JS/CSS/WASM/HTML and long-cache
 * hashed /assets and /cesium files. Vite preview otherwise ships Cesium.js
 * uncompressed with Cache-Control: no-cache, which is why phones sit on
 * the splash while 8 MB crawls in from Singapore.
 */
import { gzipSync } from 'node:zlib';

const COMPRESSIBLE = /\.(?:js|mjs|cjs|css|wasm|json|svg|html|xml|txt|map)$/i;
const LONG_CACHE = /^\/(?:assets|cesium)\//;
const MIN_GZIP_BYTES = 1024;
const gzipMemo = new Map();

function urlPath(req) {
  try {
    return decodeURIComponent(String(req.url || '').split('?')[0] || '/');
  } catch {
    return String(req.url || '/').split('?')[0] || '/';
  }
}

function wantsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers?.['accept-encoding'] || ''));
}

function isCompressible(pathname) {
  return pathname === '/' || COMPRESSIBLE.test(pathname);
}

function applyLongCache(res, pathname) {
  if (LONG_CACHE.test(pathname)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

function gzipBody(pathname, body) {
  const key = `${pathname}:${body.length}`;
  const cached = gzipMemo.get(key);
  if (cached && cached.length === body.length && cached.source.equals(body)) {
    return cached.gzipped;
  }
  const gzipped = gzipSync(body, { level: 6 });
  gzipMemo.set(key, { length: body.length, source: body, gzipped });
  return gzipped;
}

/** Connect middleware used by Vite preview (and unit tests). */
export function hostedAssetsMiddleware() {
  return function gevHostedAssets(req, res, next) {
    const pathname = urlPath(req);
    const gzip = wantsGzip(req) && isCompressible(pathname);
    applyLongCache(res, pathname);

    if (!gzip) {
      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        if (
          LONG_CACHE.test(pathname) &&
          String(name).toLowerCase() === 'cache-control'
        ) {
          return originalSetHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
        }
        return originalSetHeader(name, value);
      };
      return next();
    }

    const chunks = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);
    const originalSetHeader = res.setHeader.bind(res);
    let statusCode = res.statusCode || 200;
    let wroteHead = false;

    res.setHeader = (name, value) => {
      if (
        LONG_CACHE.test(pathname) &&
        String(name).toLowerCase() === 'cache-control'
      ) {
        return originalSetHeader(
          'Cache-Control',
          'public, max-age=31536000, immutable',
        );
      }
      return originalSetHeader(name, value);
    };

    res.writeHead = (status, extra) => {
      statusCode = status;
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [name, value] of Object.entries(extra)) {
          res.setHeader(name, value);
        }
      }
      return res;
    };

    res.write = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.from(chunk, encoding));
      if (typeof encoding === 'function') encoding();
      else if (typeof cb === 'function') cb();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk && typeof chunk !== 'function') {
        chunks.push(Buffer.from(chunk, encoding));
      }
      const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      const alreadyEncoded = res.getHeader('Content-Encoding');
      let payload = body;
      if (!alreadyEncoded && body.length >= MIN_GZIP_BYTES) {
        payload = gzipBody(pathname, body);
        originalSetHeader('Content-Encoding', 'gzip');
        originalSetHeader('Vary', 'Accept-Encoding');
      }
      originalSetHeader('Content-Length', String(payload.length));
      applyLongCache(res, pathname);
      res.write = originalWrite;
      res.end = originalEnd;
      res.writeHead = originalWriteHead;
      res.setHeader = originalSetHeader;
      if (!wroteHead) {
        wroteHead = true;
        originalWriteHead(statusCode);
      }
      if (typeof cb === 'function') return originalEnd(payload, cb);
      return originalEnd(payload);
    };

    next();
  };
}

/** Vite plugin: gzip + immutable cache on `vite preview` only. */
export function hostedAssetsPlugin() {
  return {
    name: 'gev-hosted-assets',
    configurePreviewServer(server) {
      server.middlewares.use(hostedAssetsMiddleware());
    },
  };
}
