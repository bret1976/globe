/** Fetch tsunami.gov bulletin rows from the same-origin proxy. */
export function createTsunamiAlertsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/tsunami-alerts', {
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
        throw new Error(`tsunami-alerts proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed tsunami-alerts snapshot');
      return payload;
    },
  };
}
