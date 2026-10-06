/** Fetch surface ocean currents from the same-origin proxy. */
export function createOceanCurrentsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/ocean-currents', {
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
        throw new Error(`ocean-currents proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed ocean-currents snapshot');
      return payload;
    },
  };
}
