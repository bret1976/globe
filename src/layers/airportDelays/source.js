/** Fetch FAA airport delays from the same-origin proxy. */
export function createAirportDelaysSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/airport-delays', {
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
        throw new Error(`airport delays proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed airport delays snapshot');
      return payload;
    },
  };
}
