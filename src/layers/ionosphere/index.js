/**
 * Ionosphere TEC (NOAA SWPC GloTEC) — global Total Electron Content grid,
 * refreshed every 10 minutes. Each cell is a dot floating at the F2-layer peak
 * height (hmF2), colored and sized by TEC. High TEC / sharp gradients degrade
 * single-frequency GPS accuracy and HF radio. Events group toggle.
 */
import * as Cesium from 'cesium';
import { tecColorCss, tecPixelSize } from './parse.js';

export const IONOSPHERE_LAYER_ID = 'ionosphere';
const DEFAULT_HEIGHT_KM = 300;

/** Build the ionosphere TEC globe layer. */
export function createIonosphereLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ionosphere requires a snapshot source');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let timeTag = null;

  const layer = {
    id: IONOSPHERE_LAYER_ID,
    name: 'Ionosphere TEC (SWPC)',
    icon: '📡',
    source: 'NOAA SWPC GloTEC',
    updateInterval: 10 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Ionosphere layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(IONOSPHERE_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const payload = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        if (payload?.timeTag && payload.timeTag === timeTag && count > 0) return true;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const next = [];
        for (const row of rows) {
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          if (!Number.isFinite(row.tec)) continue;
          const heightKm = Number.isFinite(row.hmF2) ? row.hmF2 : DEFAULT_HEIGHT_KM;
          const color = Cesium.Color.fromCssColorString(tecColorCss(row.tec));
          next.push(
            new Cesium.Entity({
              id: `ionosphere:${row.stableId}`,
              name: `TEC ${row.tec} TECU`,
              position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat, heightKm * 1000),
              point: {
                pixelSize: tecPixelSize(row.tec),
                color: color.withAlpha(0.55),
                outlineWidth: 0,
                scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.3, 2.0e7, 0.7),
              },
              properties: {
                tec: row.tec,
                anomaly: row.anomaly,
                hmF2Km: row.hmF2,
                nmF2: row.nmF2,
                timeTag: payload.timeTag || null,
              },
            }),
          );
        }
        dataSource.entities.suspendEvents();
        dataSource.entities.removeAll();
        for (const entity of next) dataSource.entities.add(entity);
        dataSource.entities.resumeEvents();
        count = next.length;
        timeTag = payload?.timeTag || null;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:Ionosphere] Updated: ${count} TEC cells (${timeTag || 'n/a'})`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Ionosphere] Fetch error:', error);
        lastError = error?.message || 'Ionosphere source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      viewer = null;
      enabled = false;
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      count = 0;
      lastUpdate = null;
      lastError = null;
      timeTag = null;
    },

    getStats() {
      return { count, lastUpdate, lastError, enabled, timeTag };
    },
  };

  return layer;
}

export { createIonosphereSource } from './source.js';
export {
  normalizeGlotec,
  latestGlotecFrame,
  tecColorCss,
  GLOTEC_INDEX_URL,
} from './parse.js';
