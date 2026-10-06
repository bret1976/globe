/** Fetch utility-scale power plants from the same-origin proxy. */
export function createPowerPlantsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/power-plants', {
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
        throw new Error(`power-plants proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed power-plants snapshot');
      return payload;
    },
  };
}
