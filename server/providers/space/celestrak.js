import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import { celestrakTleUrl } from '../../../src/data/spaceProviderRequests.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');

/**
 * Vite plugin: CelesTrak TLE proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite TLE data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP/TLE proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 */
export function celestrakProxy() {
  const TLE_TTL_MS = 6 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const mem = new Map(); // group -> { at: epochMs, body: string }
  const inflight = new Map(); // group -> Promise<{at, body}|null>

  const diskPath = (group) => path.join(CACHE_DIR, `celestrak-${group}.json`);

  async function readDisk(group) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
        return parsed;
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function writeDisk(group, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[celestrak-proxy] cache write failed');
    }
  }

  async function readSeed(group) {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(path.join(SEED_DIR, `celestrak-${group}.json`), 'utf8'),
      );
      if (typeof parsed?.body === 'string' && /^1 /m.test(parsed.body)) {
        return { at: Number(parsed.at) || 0, body: parsed.body };
      }
    } catch {
      /* no committed seed for this group */
    }
    return null;
  }

  async function fetchUpstream(group) {
    const hosts = ['celestrak.org', 'celestrak.com'];
    let lastError = null;
    for (const host of hosts) {
      try {
        const url = celestrakTleUrl(group);
        url.hostname = host;
        const res = await fetch(url.toString(), {
          signal: AbortSignal.timeout(8_000),
          headers: {
            'User-Agent':
              'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bret1976/globe)',
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
        return { at: Date.now(), body };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('celestrak unreachable');
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/celestrak', async (req, res) => {
      const group = String(req.url || '')
        .replace(/^\//, '')
        .split('?')[0];
      if (!/^[a-z0-9-]+$/i.test(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      const send = (status, body, cacheStatus) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          'x-tle-cache': cacheStatus,
        });
        res.end(body);
      };
      try {
        const now = Date.now();
        let entry = mem.get(group);
        if (!entry) {
          entry = await readDisk(group);
          if (entry) mem.set(group, entry);
        }
        if (!entry) {
          entry = await readSeed(group);
          if (entry) mem.set(group, entry);
        }
        if (entry && now - entry.at < TLE_TTL_MS) {
          send(200, entry.body, entry.at ? 'HIT' : 'SEED');
          return;
        }
        const refresh = () => {
          if (inflight.has(group)) return inflight.get(group);
          const pending = fetchUpstream(group)
            .then(async (fresh) => {
              mem.set(group, fresh);
              await writeDisk(group, fresh);
              return fresh;
            })
            .catch(() => {
              console.warn(
                '[celestrak-proxy] refresh failed — serving cache if any',
              );
              return null;
            })
            .finally(() => inflight.delete(group));
          inflight.set(group, pending);
          return pending;
        };
        if (entry) {
          // Serve the seed/stale catalog now. Railway often cannot reach
          // CelesTrak; waiting out that timeout left Satellites UNAVAILABLE.
          send(200, entry.body, entry.at ? 'STALE' : 'SEED');
          void refresh();
          return;
        }
        const fresh = await refresh();
        if (fresh) {
          send(200, fresh.body, 'MISS');
        } else {
          send(502, 'celestrak fetch failed and no cache available', 'NONE');
        }
      } catch (err) {
        console.error('[celestrak-proxy] request failed');
        send(500, 'celestrak proxy error', 'ERROR');
      }
    });
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
