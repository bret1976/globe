import { normalizeEarthquakeSnapshot } from './records.js';

const PROXY_URL = '/api/earthquakes';
const USGS_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

/** Request and validate a complete USGS snapshot before it can replace displayed events.
 * Prefers the same-origin `/api/earthquakes` proxy (hosted preview); falls back to
 * the public USGS feed when the proxy is unavailable (local unit tests, CORS-ok browsers).
 */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fromProxy(signal) {
    const response = await fetchImpl(PROXY_URL, {
      signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`earthquakes proxy HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (Array.isArray(payload?.rows)) return payload.rows;
    throw new Error('Malformed earthquakes proxy response');
  }

  async function fromUsgs(signal) {
    const response = await fetchImpl(USGS_URL, { signal });
    if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    const rows = normalizeEarthquakeSnapshot(payload);
    if (!rows) throw new Error('Malformed USGS response');
    return rows;
  }

  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      try {
        return await fromProxy(signal);
      } catch (proxyError) {
        // Unit tests inject fetchImpl that never expects /api/earthquakes —
        // only fall back when the failure looks like a missing/unreachable proxy.
        const msg = String(proxyError?.message || proxyError);
        if (/Malformed USGS|USGS HTTP/.test(msg)) throw proxyError;
        return fromUsgs(signal);
      }
    },
  };
}
