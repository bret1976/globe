/** Fetch Safecast radiation snapshot from the same-origin proxy. */
export function createSafecastRadiationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/radiation', {
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
        throw new Error(`radiation proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed radiation snapshot');
      return payload;
    },
  };
}
