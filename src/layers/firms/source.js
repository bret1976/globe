/**
 * Construct the existing live-fire endpoint without making a request.
 * `phoneLite` / `phoneLiteLimit` are injected by the application
 * (src/data/firmsHeatmap.js) so this source never imports src/app.
 */
export function createFirmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  phoneLite = () => false,
  phoneLiteLimit = 40_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const url = phoneLite()
        ? `/api/firms?limit=${phoneLiteLimit}`
        : '/api/firms';
      const response = await fetchImpl(url, {
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
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`FIRMS HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires))
        throw new Error('Malformed fire snapshot');
      return payload;
    },
  };
}
