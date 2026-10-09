/**
 * NASA JPL fireballs — bolide / fireball events as points at reported
 * altitude, sized and colored by radiated energy. Events group toggle.
 */
import * as Cesium from 'cesium';
import { fireballColorCss, fireballPixelSize } from './parse.js';

export const FIREBALLS_LAYER_ID = 'fireballs';
export const FIREBALLS_OVERLAY_SOURCE_ID = 'fireballs';
export const FIREBALLS_OVERLAY_COHORT_LIMIT = 20;
export const FIREBALLS_OVERLAY_COLLISION_CAPACITY = 14;

export function formatFireballLabel(row) {
  const bits = ['Fireball'];
  if (Number.isFinite(row.energyKt)) bits.push(`${row.energyKt} kt`);
  if (Number.isFinite(row.altKm)) bits.push(`${row.altKm} km`);
  const day = String(row.observedAt || '').slice(0, 10);
  if (day) bits.push(day);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatFireballLabel(row),
    accent: fireballColorCss(row.energyKt),
    priority: 1000 + Math.min(500, (Number(row.energyKt) || 0) * 10),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

function selectOverlayCohort(entries) {
  return [...entries]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, FIREBALLS_OVERLAY_COHORT_LIMIT);
}

/** Build the NASA JPL fireballs globe layer. */
export function createFireballsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fireballs require a snapshot source');
  if (!overlayHost) throw new TypeError('Fireballs require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: FIREBALLS_LAYER_ID,
    name: 'Fireballs (NASA JPL)',
    icon: '☄️',
    source: 'NASA/JPL Fireball Data API',
    updateInterval: 60 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Fireballs layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(FIREBALLS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(FIREBALLS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(FIREBALLS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(FIREBALLS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIREBALLS_OVERLAY_SOURCE_ID, false);
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

        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const nextEntities = [];
        const overlayEntries = [];
        for (const row of rows) {
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const altM = Math.max(0, Number(row.altM) || 30_000);
          const color = Cesium.Color.fromCssColorString(
            fireballColorCss(row.energyKt),
          );
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, altM);
          const ground = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0);
          const size = fireballPixelSize(row.energyKt);
          nextEntities.push(
            new Cesium.Entity({
              id: `fireball:${row.stableId}`,
              position,
              point: {
                pixelSize: size,
                color: color.withAlpha(0.95),
                heightReference: Cesium.HeightReference.NONE,
                outlineColor: Cesium.Color.WHITE.withAlpha(0.45),
                outlineWidth: 1,
              },
              polyline: {
                positions: [ground, position],
                width: 1,
                arcType: Cesium.ArcType.NONE,
                material: color.withAlpha(0.28),
              },
              properties: {
                observedAt: row.observedAt,
                energyKt: row.energyKt,
                impactEj: row.impactEj,
                altKm: row.altKm,
                velKms: row.velKms,
              },
            }),
          );
          if ((Number(row.energyKt) || 0) >= 5) {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            FIREBALLS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: FIREBALLS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: FIREBALLS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:Fireballs] Updated: ${count} events`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Fireballs] Fetch error:', error);
        lastError = error?.message || 'Fireballs source unavailable';
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
      overlayHost.clearSource(FIREBALLS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FIREBALLS_OVERLAY_SOURCE_ID, false);
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getStats() {
      return { count, lastUpdate, lastError, enabled };
    },
  };

  return layer;
}

export { createFireballsSource } from './source.js';
export {
  normalizeFireballs,
  parseFireball,
  fireballColorCss,
  fireballPixelSize,
  FIREBALLS_URL,
} from './parse.js';
