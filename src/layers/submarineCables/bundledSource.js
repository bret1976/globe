// Free OpenStreetMap-derived submarine cable extract (ODbL 1.0).
// TeleGeography proprietary dump is NOT shipped. Folder path is legacy.
// See DATA_SOURCES.md and the bundled dataset's source.json.
const cableUrl = new URL(
  '../../data/local_data/telegeography_submarine_cables/cable-geo.json',
  import.meta.url,
).href;
const landingPointUrl = new URL(
  '../../data/local_data/telegeography_submarine_cables/landing-point-geo.json',
  import.meta.url,
).href;

/** Supply GeoJSON collections without coupling the renderer to asset URLs. */
export function createBundledCableSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  async function read(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'force-cache' });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* best effort */
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const json = await response.json();
    signal?.throwIfAborted();
    return json;
  }
  return {
    label: 'OpenStreetMap submarine cables (ODbL)',
    async fetch(signal) {
      const [cables, landingPoints] = await Promise.all([
        read(cableUrl, signal),
        read(landingPointUrl, signal),
      ]);
      return { cables, landingPoints };
    },
  };
}
