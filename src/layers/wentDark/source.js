import { aircraftWentDarkSnapshot } from '../../data/wentDarkAircraft.js';

/**
 * Went-dark source: ships from the server's AIS tracker, aircraft from the
 * in-browser tracker fed by the Flights layer.
 */
export function createWentDarkSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  aircraft = aircraftWentDarkSnapshot,
} = {}) {
  return {
    async getSnapshot(_query = {}, { signal } = {}) {
      let ships;
      try {
        const response = await fetchImpl('/api/ais-live/dark', {
          signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`AIS went-dark HTTP ${response.status}`);
        ships = await response.json();
        // Server and browser clocks never mix: ages come from the server.
        ships.receivedAtMs = Date.now();
      } catch (error) {
        if (signal?.aborted) throw error;
        ships = {
          status: 'stale',
          reason: error?.message || 'AIS went-dark endpoint unavailable',
          flagged: [],
          tracked: 0,
          steady: 0,
        };
      }
      return { ships, aircraft: aircraft() };
    },
  };
}
