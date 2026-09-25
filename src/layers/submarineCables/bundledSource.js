// OpenStreetMap submarine cables (ODbL 1.0) — legal OSS path for the
// digital-nervous / cable layer. TeleGeography CC BY-NC-SA dumps stay in
// tree under local_data/telegeography_submarine_cables/ for reference only
// and are NOT loaded at runtime (Bret hard rule: no proprietary cable dumps).
// Geometry shape matches the prior TeleGeography wiring so Cesium ingest
// stays unchanged. Attribution: © OpenStreetMap contributors.
const cableUrl = new URL(
  '../../data/local_data/osm_submarine_cables/cable-geo.json',
  import.meta.url,
).href;
const landingPointUrl = new URL(
  '../../data/local_data/osm_submarine_cables/landing-point-geo.json',
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
    label: 'OpenStreetMap',
    async fetch(signal) {
      const [cables, landingPoints] = await Promise.all([
        read(cableUrl, signal),
        read(landingPointUrl, signal),
      ]);
      return { cables, landingPoints };
    },
  };
}
