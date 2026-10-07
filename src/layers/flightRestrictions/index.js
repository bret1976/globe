/**
 * FAA Temporary Flight Restrictions — live TFR outlines draped on the globe,
 * colored by type (VIP movement, security, hazards/wildfire, air shows &
 * sports, UAS gatherings, space ops). Events group toggle.
 */
import * as Cesium from 'cesium';
import { flightRestrictionColorCss } from './parse.js';

export const FLIGHT_RESTRICTIONS_LAYER_ID = 'flight-restrictions';
export const FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID = 'flight-restrictions';
export const FLIGHT_RESTRICTIONS_OVERLAY_COHORT_LIMIT = 32;
export const FLIGHT_RESTRICTIONS_OVERLAY_COLLISION_CAPACITY = 24;

const KIND_LABELS = Object.freeze({
  vip: 'VIP TFR',
  security: 'Security TFR',
  hazards: 'Hazard TFR',
  sports: 'Air show / sports TFR',
  uas: 'UAS gathering TFR',
  space: 'Space ops TFR',
  other: 'TFR',
});

const LABELED_KINDS = new Set(['vip', 'security', 'hazards', 'space']);
const KIND_PRIORITY = Object.freeze({ vip: 4, space: 3, security: 2, hazards: 1 });

export function flightRestrictionKindLabel(kind) {
  return KIND_LABELS[kind] || KIND_LABELS.other;
}

function placeName(title) {
  return String(title || '').split(',').slice(0, 2).join(',').trim();
}

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: `${flightRestrictionKindLabel(row.kind)} · ${placeName(row.title)}`,
    accent: flightRestrictionColorCss(row.kind),
    priority: 1000 + (KIND_PRIORITY[row.kind] || 0) * 1000,
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
    .slice(0, FLIGHT_RESTRICTIONS_OVERLAY_COHORT_LIMIT);
}

/** Build the FAA TFR globe layer. */
export function createFlightRestrictionsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Flight restrictions require a snapshot source');
  if (!overlayHost) throw new TypeError('Flight restrictions require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: FLIGHT_RESTRICTIONS_LAYER_ID,
    name: 'Flight Restrictions (FAA)',
    icon: '⛔',
    source: 'FAA Graphic TFRs',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Flight restrictions layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(FLIGHT_RESTRICTIONS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID, false);
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
          if (!Array.isArray(row.ring) || row.ring.length < 3) continue;
          if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
          const flat = [];
          for (const [lon, lat] of row.ring) flat.push(lon, lat);
          const positions = Cesium.Cartesian3.fromDegreesArray(flat);
          const color = Cesium.Color.fromCssColorString(
            flightRestrictionColorCss(row.kind),
          );
          const strong = row.kind === 'vip' || row.kind === 'security';
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `flight-restriction:${row.stableId}`,
              name: `${flightRestrictionKindLabel(row.kind)} ${row.notamId || ''}`.trim(),
              position: center,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(positions),
                material: color.withAlpha(strong ? 0.22 : 0.14),
                classificationType: Cesium.ClassificationType.BOTH,
              },
              polyline: {
                positions: [...positions, positions[0]],
                width: strong ? 2.5 : 1.5,
                material: color.withAlpha(0.9),
                clampToGround: true,
                classificationType: Cesium.ClassificationType.BOTH,
              },
              properties: {
                notamId: row.notamId,
                type: row.type,
                title: row.title,
                state: row.state,
                facility: row.facility,
                modified: row.modified,
                radiusKm: row.radiusKm,
                faaUrl: row.faaUrl,
              },
            }),
          );
          if (LABELED_KINDS.has(row.kind)) {
            overlayEntries.push(createOverlayEntry(row, center));
          }
        }

        dataSource.entities.suspendEvents();
        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        dataSource.entities.resumeEvents();
        if (enabled) {
          overlayHost.setEntries(
            FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: FLIGHT_RESTRICTIONS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: FLIGHT_RESTRICTIONS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:FlightRestrictions] Updated: ${count} TFR outlines`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:FlightRestrictions] Fetch error:', error);
        lastError = error?.message || 'Flight restrictions source unavailable';
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
      overlayHost.clearSource(FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FLIGHT_RESTRICTIONS_OVERLAY_SOURCE_ID, false);
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

export { createFlightRestrictionsSource } from './source.js';
export {
  normalizeFlightRestrictions,
  flightRestrictionKind,
  flightRestrictionColorCss,
  FLIGHT_RESTRICTIONS_URL,
} from './parse.js';
