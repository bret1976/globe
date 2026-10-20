import { CRW_ERDDAP_URL, coralErddapPayload } from './parse.js';

/**
 * Fetch NOAA Coral Reef Watch stations from the same-origin proxy. When the
 * proxy can't answer (CRW host and server-side fallback both down), load the
 * gridded CRW product straight from PacIOOS ERDDAP (CORS-enabled, keyless).
 */
export function createCoralBleachingSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  directUrl = CRW_ERDDAP_URL,
} = {}) {
  async function direct(signal, cause) {
    let response;
    try {
      response = await fetchImpl(directUrl, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw cause || error;
    }
    signal?.throwIfAborted();
    if (!response.ok)
      throw cause || new Error(`ERDDAP HTTP ${response.status}`);
    const payload = coralErddapPayload(await response.text());
    if (!payload.rows.length)
      throw cause || new Error('ERDDAP returned no cells');
    return { ...payload, browserDirect: true };
  }
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      let failure;
      try {
        const response = await fetchImpl('/api/coral-bleaching', {
          signal,
          cache: 'no-store',
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          /* status below remains authoritative */
        }
        signal?.throwIfAborted();
        if (!response.ok)
          throw new Error(`coral bleaching proxy HTTP ${response.status}`);
        if (!Array.isArray(payload?.rows))
          throw new Error('Malformed coral bleaching snapshot');
        return payload;
      } catch (error) {
        signal?.throwIfAborted();
        failure = error;
      }
      return direct(signal, failure);
    },
  };
}
