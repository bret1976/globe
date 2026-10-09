/**
 * Aviation Weather Center hazards — SIGMET / G-AIRMET / CWA outlines draped
 * on the globe, colored by hazard family. Events group toggle.
 * Situational awareness only — not for flight planning.
 */
import * as Cesium from 'cesium';
import { aviationHazardColorCss } from './parse.js';

export const AVIATION_HAZARDS_LAYER_ID = 'aviation-hazards';
export const AVIATION_HAZARDS_OVERLAY_SOURCE_ID = 'aviation-hazards';
export const AVIATION_HAZARDS_OVERLAY_COHORT_LIMIT = 28;
export const AVIATION_HAZARDS_OVERLAY_COLLISION_CAPACITY = 20;

const PRODUCT_LABELS = Object.freeze({
  sigmet: 'SIGMET',
  gairmet: 'G-AIRMET',
  cwa: 'CWA',
});

const FAMILY_PRIORITY = Object.freeze({
  convective: 5,
  turb: 4,
  ice: 3,
  ifr: 2,
  wind: 1,
  other: 0,
});

export function aviationHazardLabel(row) {
  const product = PRODUCT_LABELS[row.product] || 'AWC';
  const tag = row.seriesId || row.tag || '';
  return `${product} ${row.hazard}${tag ? ` · ${tag}` : ''}`.trim();
}

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: aviationHazardLabel(row),
    accent: aviationHazardColorCss(row.family || row.hazard),
    priority: 1000 + (FAMILY_PRIORITY[row.family] || 0) * 1000,
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
  const seen = new Set();
  return [...entries]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .filter((entry) => {
      if (seen.has(entry.title)) return false;
      seen.add(entry.title);
      return true;
    })
    .slice(0, AVIATION_HAZARDS_OVERLAY_COHORT_LIMIT);
}

/** Build the AWC aviation hazards globe layer. */
export function createAviationHazardsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Aviation hazards require a snapshot source');
  if (!overlayHost) throw new TypeError('Aviation hazards require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: AVIATION_HAZARDS_LAYER_ID,
    name: 'Aviation Hazards (AWC)',
    icon: '⚠️',
    source: 'Aviation Weather Center',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Aviation hazards layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(AVIATION_HAZARDS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(AVIATION_HAZARDS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(AVIATION_HAZARDS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(AVIATION_HAZARDS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AVIATION_HAZARDS_OVERLAY_SOURCE_ID, false);
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
          if (!Array.isArray(row.ring) || row.ring.length < 2) continue;
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const flat = [];
          for (const [lon, lat] of row.ring) flat.push(lon, lat);
          const positions = Cesium.Cartesian3.fromDegreesArray(flat);
          const color = Cesium.Color.fromCssColorString(
            aviationHazardColorCss(row.family || row.hazard),
          );
          const isArea = row.geometryType !== 'line' && row.ring.length >= 3;
          const strong = row.product === 'sigmet' || row.family === 'convective';
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const entity = new Cesium.Entity({
            id: `aviation-hazard:${row.stableId}`,
            name: aviationHazardLabel(row),
            position: center,
            polyline: {
              positions: isArea ? [...positions, positions[0]] : positions,
              width: strong ? 2.5 : 1.5,
              material: color.withAlpha(0.9),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
            properties: {
              product: row.product,
              hazard: row.hazard,
              family: row.family,
              seriesId: row.seriesId,
              tag: row.tag,
              validFrom: row.validFrom,
              validTo: row.validTo,
              radiusKm: row.radiusKm,
              raw: row.raw,
            },
          });
          if (isArea) {
            entity.polygon = {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              material: color.withAlpha(strong ? 0.22 : 0.14),
              classificationType: Cesium.ClassificationType.BOTH,
            };
          }
          nextEntities.push(entity);
          if (row.product === 'sigmet' || row.family === 'convective') {
            overlayEntries.push(createOverlayEntry(row, center));
          }
        }

        dataSource.entities.suspendEvents();
        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        dataSource.entities.resumeEvents();
        if (enabled) {
          overlayHost.setEntries(
            AVIATION_HAZARDS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: AVIATION_HAZARDS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: AVIATION_HAZARDS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:AviationHazards] Updated: ${count} outlines`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:AviationHazards] Fetch error:', error);
        lastError = error?.message || 'Aviation hazards source unavailable';
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
      overlayHost.clearSource(AVIATION_HAZARDS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AVIATION_HAZARDS_OVERLAY_SOURCE_ID, false);
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

export { createAviationHazardsSource } from './source.js';
export {
  normalizeAviationHazards,
  parseAviationHazard,
  aviationHazardFamily,
  aviationHazardColorCss,
  AWC_SIGMET_URL,
  AWC_GAIRMET_URL,
  AWC_CWA_URL,
} from './parse.js';
