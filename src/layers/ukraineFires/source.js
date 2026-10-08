/** Fetch Ukraine war fire detections from the same-origin FIRMS proxy. */
export function createUkraineFiresSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 60_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const scoped = AbortSignal.any(
        [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
      );
      const response = await fetchImpl('/api/ukraine-fires', {
        signal: scoped,
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
        throw new Error(
          payload?.error || `Ukraine fires proxy HTTP ${response.status}`,
        );
      if (!Array.isArray(payload?.points))
        throw new Error('Malformed Ukraine fires snapshot');
      return payload;
    },
  };
}
