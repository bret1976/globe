import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import {
  celestrakTleUrl,
  fallbackTleUrl,
} from '../../../src/data/spaceProviderRequests.js';

const SEED_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'seed',
);

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
        await fsp.readFile(
          path.join(SEED_DIR, `celestrak-${group}.json`),
          'utf8',
        ),
      );
      if (typeof parsed?.body === 'string' && /^1 /m.test(parsed.body)) {
        return { at: Number(parsed.at) || 0, body: parsed.body };
      }
    } catch {
      /* no committed seed for this group */
    }
    return null;
  }

  const UA =
    'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bret1976/globe)';
  // CelesTrak firewall-bans IPs that poll too often, and a banned IP looks
  // like a connect timeout. Retrying on every stale request kept the ban
  // alive, so failures now back off (15 min doubling to 6 h), host-wide.
  const BACKOFF_MIN_MS = 15 * 60_000;
  const BACKOFF_MAX_MS = 6 * 3600_000;
  let primaryFailures = 0;
  let primaryBlockedUntil = 0;
  const groupFailures = new Map(); // group -> { n, until }

  const backoff = (n) =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, n - 1));

  async function fetchCelestrak(group) {
    if (Date.now() < primaryBlockedUntil) throw new Error('celestrak backoff');
    const hosts = ['celestrak.org', 'celestrak.com'];
    let lastError = null;
    for (const host of hosts) {
      try {
        const url = celestrakTleUrl(group);
        url.hostname = host;
        const res = await fetch(url.toString(), {
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': UA },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
        primaryFailures = 0;
        primaryBlockedUntil = 0;
        return { at: Date.now(), body, source: 'celestrak' };
      } catch (error) {
        lastError = error;
      }
    }
    primaryFailures += 1;
    primaryBlockedUntil = Date.now() + backoff(primaryFailures);
    throw lastError || new Error('celestrak unreachable');
  }

  /** Parse a 3-line TLE body into [{ name, id, l1, l2 }]. */
  function parseTle(body) {
    const lines = String(body).split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^1 \d{5}/.test(lines[i]) && /^2 \d{5}/.test(lines[i + 1] || '')) {
        const prev = lines[i - 1] || '';
        const name = /^[12] /.test(prev) ? '' : prev.trim();
        out.push({
          name,
          id: lines[i].slice(2, 7),
          l1: lines[i],
          l2: lines[i + 1],
        });
        i++;
      }
    }
    return out;
  }

  /**
   * Fallback: refresh every satellite already in the cached/seed catalog,
   * one NORAD id at a time, from tle.ivanstanojevic.me. Satellites it cannot
   * refresh keep their previous elements; at least half must refresh.
   */
  async function fetchFallback(prior) {
    const sats = parseTle(prior?.body || '');
    if (!sats.length) throw new Error('no catalog to refresh from fallback');
    let ok = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < sats.length) {
        const sat = sats[cursor++];
        try {
          const res = await fetch(fallbackTleUrl(sat.id).toString(), {
            signal: AbortSignal.timeout(8_000),
            headers: { 'User-Agent': UA, Accept: 'application/json' },
          });
          if (!res.ok) continue;
          const j = await res.json();
          if (
            typeof j?.line1 === 'string' &&
            j.line1.startsWith(`1 ${sat.id}`) &&
            typeof j?.line2 === 'string' &&
            j.line2.startsWith(`2 ${sat.id}`)
          ) {
            sat.l1 = j.line1;
            sat.l2 = j.line2;
            ok++;
          }
        } catch {
          /* keep previous elements for this satellite */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, sats.length) }, worker));
    if (ok < Math.ceil(sats.length / 2))
      throw new Error(`fallback refreshed ${ok}/${sats.length}`);
    const body =
      sats.map((s) => `${s.name}\n${s.l1}\n${s.l2}`).join('\n') + '\n';
    return { at: Date.now(), body, source: 'fallback' };
  }

  async function fetchUpstream(group, prior) {
    try {
      return await fetchCelestrak(group);
    } catch (primaryError) {
      console.warn(
        '[celestrak-proxy] CelesTrak unavailable — trying fallback TLE source',
      );
      return fetchFallback(prior);
    }
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
      let entry = null;
      const send = (status, body, cacheStatus) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          'x-tle-cache': cacheStatus,
          'x-tle-source': entry?.source || (entry?.at ? 'celestrak' : 'seed'),
        });
        res.end(body);
      };
      try {
        const now = Date.now();
        entry = mem.get(group);
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
          const failed = groupFailures.get(group);
          if (entry && failed && Date.now() < failed.until)
            return Promise.resolve(null);
          const pending = fetchUpstream(group, entry)
            .then(async (fresh) => {
              groupFailures.delete(group);
              mem.set(group, fresh);
              await writeDisk(group, fresh);
              return fresh;
            })
            .catch(() => {
              const n = (groupFailures.get(group)?.n || 0) + 1;
              groupFailures.set(group, { n, until: Date.now() + backoff(n) });
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
          entry = fresh;
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
