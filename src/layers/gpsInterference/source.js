/** Fetch the gpsjam.org interference snapshot from the same-origin proxy. */
export function createGpsjamSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal, date = null } = {}) {
      signal?.throwIfAborted();
      const url = date
        ? `/api/gpsjam?date=${encodeURIComponent(date)}`
        : '/api/gpsjam';
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
      if (!response.ok)
        throw new Error(`gpsjam proxy HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed gpsjam snapshot');
      return payload;
    },

    /** Published day list (newest last) from the gpsjam manifest. */
    async getDates({ signal } = {}) {
      const response = await fetchImpl('/api/gpsjam/dates', {
        signal,
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error(`gpsjam dates HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.dates))
        throw new Error('Malformed gpsjam date list');
      return payload.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    },
  };
}
