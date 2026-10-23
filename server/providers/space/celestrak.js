import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fsp } from 'node:fs';
import {
  celestrakOmmUrl,
  fallbackTleUrl,
  mirrorOmmUrl,
  mirrorTleUrl,
} from '../../../src/data/spaceProviderRequests.js';

const SEED_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'seed',
);

/**
 * Vite plugin: CelesTrak GP proxy (OMM JSON, TLE accepted from old caches).
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite element sets server-side and forwards them to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP proxy with a memory + disk cache (GROUP=<group>&FORMAT=json).
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=json
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

  // OMM JSON is the only GP format with catalog numbers above 99999 (CelesTrak
  // began assigning them in 2026: new ISS visiting vehicles, fresh launches).
  // TLE text stays accepted from older caches, seeds and the TLE-only mirror.
  const isOmmBody = (body) =>
    /^\s*\[\s*\{/.test(String(body)) && String(body).includes('"NORAD_CAT_ID"');
  const isTleBody = (body) => /^1 /m.test(String(body));
  const isElementsBody = (body) => isOmmBody(body) || isTleBody(body);
  const parseOmm = (body) => {
    try {
      const rows = JSON.parse(String(body));
      return Array.isArray(rows)
        ? rows.filter((r) => r && typeof r === 'object')
        : [];
    } catch {
      return [];
    }
  };

  async function readSeed(group) {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(
          path.join(SEED_DIR, `celestrak-${group}.json`),
          'utf8',
        ),
      );
      if (typeof parsed?.body === 'string' && isElementsBody(parsed.body)) {
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
  // The fallback host answers 508 "resource limit" when hammered: every
  // group shares one small pool, and a partial refresh retries in 30 min.
  const FALLBACK_CONCURRENCY = 2;
  const FALLBACK_RETRY_MS = 1_500;
  const PARTIAL_RETRY_MS = 30 * 60_000;
  let fallbackActive = 0;
  const fallbackQueue = [];
  const fallbackSlot = () =>
    new Promise((resolve) => {
      const go = () => {
        fallbackActive++;
        resolve(() => {
          fallbackActive--;
          fallbackQueue.shift()?.();
        });
      };
      if (fallbackActive < FALLBACK_CONCURRENCY) go();
      else fallbackQueue.push(go);
    });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchFallbackOne(id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const release = await fallbackSlot();
      let status = 0;
      try {
        const res = await fetch(fallbackTleUrl(id).toString(), {
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        status = res.status;
        if (res.ok) return await res.json();
      } catch {
        /* timeout or network: give up on this id */
      } finally {
        release();
      }
      // Only rate-limit answers are retried; a network error means the
      // host is unreachable, and retrying it only stretches the refresh.
      if (status !== 429 && status !== 503 && status !== 508) return null;
      if (attempt === 0) await pause(FALLBACK_RETRY_MS);
    }
    return null;
  }

  const backoff = (n) =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, n - 1));

  async function fetchCelestrak(group) {
    if (Date.now() < primaryBlockedUntil) throw new Error('celestrak backoff');
    const hosts = ['celestrak.org', 'celestrak.com'];
    let lastError = null;
    for (const host of hosts) {
      try {
        const url = celestrakOmmUrl(group);
        url.hostname = host;
        const res = await fetch(url.toString(), {
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': UA },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        // An error page parses to zero records: a failure, keep the cache.
        if (!isOmmBody(body)) throw new Error('no OMM records in response');
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

  /** Newest element-set epoch in an OMM or TLE body, as epoch ms (0 when none parse). */
  function newestEpochMs(body) {
    let best = 0;
    if (isOmmBody(body)) {
      for (const row of parseOmm(body)) {
        if (typeof row.EPOCH !== 'string') continue;
        // OMM EPOCH is UTC with microseconds and no zone designator.
        const at = Date.parse(row.EPOCH.slice(0, 23) + 'Z');
        if (Number.isFinite(at)) best = Math.max(best, at);
      }
      return best;
    }
    for (const line of String(body).split(/\r?\n/)) {
      if (!line.startsWith('1 ')) continue;
      const yy = Number(line.slice(18, 20));
      const day = Number(line.slice(20, 32));
      if (!Number.isFinite(yy) || !Number.isFinite(day)) continue;
      const year = yy < 57 ? 2000 + yy : 1900 + yy;
      best = Math.max(best, Date.UTC(year, 0, 1) + (day - 1) * 86400_000);
    }
    return best;
  }

  // First fallback: a GitHub mirror of CelesTrak's own group files
  // (satvisorcom/satvisor-data, cron-refreshed). Same group, one request,
  // OMM JSON first (six-digit ids), its TLE copy second; rejected when the
  // newest epoch is over 5 days old.
  const MIRROR_MAX_AGE_MS = 5 * 86400_000;
  async function fetchMirror(group) {
    try {
      const res = await fetch(mirrorOmmUrl(group).toString(), {
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': UA },
      });
      if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
      const body = await res.text();
      if (!isOmmBody(body)) throw new Error('mirror: no OMM records');
      if (Date.now() - newestEpochMs(body) > MIRROR_MAX_AGE_MS)
        throw new Error('mirror: stale');
      return { at: Date.now(), body, source: 'mirror' };
    } catch {
      return fetchMirrorTle(group);
    }
  }

  async function fetchMirrorTle(group) {
    const res = await fetch(mirrorTleUrl(group).toString(), {
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`mirror HTTP ${res.status}`);
    const body = await res.text();
    if (!/^1 /m.test(body)) throw new Error('mirror: no TLE lines');
    if (Date.now() - newestEpochMs(body) > MIRROR_MAX_AGE_MS)
      throw new Error('mirror: stale');
    return { at: Date.now(), body, source: 'mirror' };
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

  // Bulk fallback: SatNOGS DB serves its whole TLE catalog (Space-Track
  // derived, keyless) in one JSON call, so one request refreshes every
  // group. Shared across groups and cached for 2 h.
  const SATNOGS_TLE_URL = 'https://db.satnogs.org/api/tle/?format=json';
  const BULK_TTL_MS = 2 * 3600_000;
  const PER_ID_CAP = 60; // tle.ivanstanojevic.me allows ~500 req per window
  let bulk = null; // { at, byId: Map<id, {l1, l2}> }
  let bulkPending = null;
  async function fetchBulk() {
    if (bulk && Date.now() - bulk.at < BULK_TTL_MS) return bulk.byId;
    if (bulkPending) return bulkPending;
    bulkPending = (async () => {
      try {
        const res = await fetch(SATNOGS_TLE_URL, {
          signal: AbortSignal.timeout(30_000),
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`satnogs ${res.status}`);
        const rows = await res.json();
        const byId = new Map();
        for (const r of Array.isArray(rows) ? rows : []) {
          if (typeof r?.tle1 === 'string' && typeof r?.tle2 === 'string')
            byId.set(String(r.norad_cat_id), { l1: r.tle1, l2: r.tle2 });
        }
        if (!byId.size) throw new Error('satnogs empty');
        bulk = { at: Date.now(), byId };
        return byId;
      } catch {
        return bulk?.byId || new Map();
      } finally {
        bulkPending = null;
      }
    })();
    return bulkPending;
  }

  const validFor = (sat, l1, l2) =>
    typeof l1 === 'string' &&
    l1.startsWith(`1 ${sat.id}`) &&
    typeof l2 === 'string' &&
    l2.startsWith(`2 ${sat.id}`);

  /**
   * Fallback: refresh every satellite already in the cached/seed catalog,
   * first from the SatNOGS bulk catalog, then (for a few leftovers) one NORAD
   * id at a time from tle.ivanstanojevic.me. Satellites neither source can
   * refresh keep their previous elements; at least half must refresh.
   */
  async function fetchFallback(prior) {
    if (isOmmBody(prior?.body)) return fetchFallbackOmm(prior);
    const sats = parseTle(prior?.body || '');
    if (!sats.length) throw new Error('no catalog to refresh from fallback');
    let ok = 0;
    const byId = await fetchBulk();
    const missing = [];
    for (const sat of sats) {
      const t = byId.get(String(Number(sat.id)));
      if (t && validFor(sat, t.l1, t.l2)) {
        sat.l1 = t.l1;
        sat.l2 = t.l2;
        ok++;
      } else missing.push(sat);
    }
    await Promise.all(
      missing.slice(0, PER_ID_CAP).map(async (sat) => {
        const j = await fetchFallbackOne(sat.id).catch(() => null);
        if (validFor(sat, j?.line1, j?.line2)) {
          sat.l1 = j.line1;
          sat.l2 = j.line2;
          ok++;
        }
      }),
    );
    if (ok < Math.ceil(sats.length / 2))
      throw new Error(`fallback refreshed ${ok}/${sats.length}`);
    const body =
      sats.map((s) => `${s.name}\n${s.l1}\n${s.l2}`).join('\n') + '\n';
    // A partial refresh counts as fresh for only 30 min, so the satellites
    // it missed are asked for again soon (the merged body is the next base).
    const at =
      ok < sats.length * 0.9
        ? Date.now() - TLE_TTL_MS + PARTIAL_RETRY_MS
        : Date.now();
    return { at, body, source: 'fallback', refreshed: ok, total: sats.length };
  }

  /**
   * Fallback for an OMM catalog. The fallback sources only speak TLE, so a
   * five-digit object they refresh is written back as an item carrying
   * TLE_LINE1/TLE_LINE2 (the browser parses either form); six-digit objects
   * cannot be refreshed there and keep their previous OMM elements.
   */
  async function fetchFallbackOmm(prior) {
    const rows = parseOmm(prior.body);
    const tleId = (line) => Number(String(line || '').slice(2, 7));
    const valid = (id, l1, l2) =>
      typeof l1 === 'string' &&
      typeof l2 === 'string' &&
      l1.startsWith('1 ') &&
      l2.startsWith('2 ') &&
      tleId(l1) === id &&
      tleId(l2) === id;
    const refreshable = rows.filter(
      (r) => Number.isSafeInteger(r.NORAD_CAT_ID) && r.NORAD_CAT_ID <= 99999,
    );
    if (!refreshable.length)
      throw new Error('no five-digit catalog to refresh from fallback');
    const byId = await fetchBulk();
    const updated = new Map();
    const missing = [];
    for (const row of refreshable) {
      const t = byId.get(String(row.NORAD_CAT_ID));
      if (t && valid(row.NORAD_CAT_ID, t.l1, t.l2))
        updated.set(row, { l1: t.l1, l2: t.l2 });
      else missing.push(row);
    }
    await Promise.all(
      missing.slice(0, PER_ID_CAP).map(async (row) => {
        const j = await fetchFallbackOne(row.NORAD_CAT_ID).catch(() => null);
        if (valid(row.NORAD_CAT_ID, j?.line1, j?.line2))
          updated.set(row, { l1: j.line1, l2: j.line2 });
      }),
    );
    const ok = updated.size;
    if (ok < Math.ceil(refreshable.length / 2))
      throw new Error(`fallback refreshed ${ok}/${refreshable.length}`);
    const body = JSON.stringify(
      rows.map((row) => {
        const t = updated.get(row);
        return t
          ? {
              OBJECT_NAME: row.OBJECT_NAME,
              OBJECT_ID: row.OBJECT_ID,
              NORAD_CAT_ID: row.NORAD_CAT_ID,
              TLE_LINE1: t.l1,
              TLE_LINE2: t.l2,
            }
          : row;
      }),
    );
    const at =
      ok < refreshable.length * 0.9
        ? Date.now() - TLE_TTL_MS + PARTIAL_RETRY_MS
        : Date.now();
    return {
      at,
      body,
      source: 'fallback',
      refreshed: ok,
      total: refreshable.length,
    };
  }

  async function fetchUpstream(group, prior) {
    try {
      return await fetchCelestrak(group);
    } catch (primaryError) {
      console.warn(
        '[celestrak-proxy] CelesTrak unavailable — trying fallback TLE source',
      );
      try {
        return await fetchMirror(group);
      } catch {
        return fetchFallback(prior);
      }
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
          // OMM bodies are JSON (and get gzipped by the standalone server).
          'Content-Type':
            status === 200 && isOmmBody(body)
              ? 'application/json; charset=utf-8'
              : 'text/plain',
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
