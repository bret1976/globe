/** Fetch the global ionosphere TEC grid from the same-origin proxy. */
export function createIonosphereSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/ionosphere', {
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
      if (!response.ok) throw new Error(`ionosphere proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows)) throw new Error('Malformed ionosphere snapshot');
      return payload;
    },
  };
}
