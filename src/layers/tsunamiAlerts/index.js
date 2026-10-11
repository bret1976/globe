/**
 * NOAA/NWS tsunami.gov bulletins — category-colored discs on the globe.
 * Warning / Advisory / Watch / Information from NTWC (PAAQ) + PTWC (PHEB).
 */
import * as Cesium from 'cesium';
import { tsunamiCategoryColorCss } from './parse.js';

export const TSUNAMI_ALERTS_LAYER_ID = 'tsunami-alerts';
export const TSUNAMI_ALERTS_OVERLAY_SOURCE_ID = 'tsunami-alerts';
export const TSUNAMI_ALERTS_OVERLAY_COHORT_LIMIT = 24;
export const TSUNAMI_ALERTS_OVERLAY_COLLISION_CAPACITY = 16;

const RADIUS_BY_CATEGORY = Object.freeze({
  Warning: 90_000,
  Advisory: 70_000,
  Watch: 55_000,
  Information: 40_000,
  Unknown: 32_000,
});

function colorFor(category) {
  return Cesium.Color.fromCssColorString(tsunamiCategoryColorCss(category));
}

function createOverlayEntry(row, position) {
  const accent = tsunamiCategoryColorCss(row.category);
  const mag =
    Number.isFinite(row.magnitude) ? ` M${row.magnitude}` : '';
  const title = `Tsunami ${row.category}${mag} · ${row.region}`;
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title,
    accent,
    priority: 1000 + (Number(row.categoryRank) || 0) * 1000,
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
    .slice(0, TSUNAMI_ALERTS_OVERLAY_COHORT_LIMIT);
}

/** Build the tsunami.gov alerts globe layer. */
export function createTsunamiAlertsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Tsunami alerts require a snapshot source');
  if (!overlayHost) throw new TypeError('Tsunami alerts require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: TSUNAMI_ALERTS_LAYER_ID,
    name: 'Tsunami Alerts (NOAA)',
    icon: '🌊',
    source: 'NOAA/NWS tsunami.gov Atom (PAAQ + PHEB)',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Tsunami alerts layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(TSUNAMI_ALERTS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(TSUNAMI_ALERTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(TSUNAMI_ALERTS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(TSUNAMI_ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TSUNAMI_ALERTS_OVERLAY_SOURCE_ID, false);
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
          const color = colorFor(row.category);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM =
            RADIUS_BY_CATEGORY[row.category] || RADIUS_BY_CATEGORY.Unknown;
          const isHigh =
            row.category === 'Warning' || row.category === 'Advisory';
          nextEntities.push(
            new Cesium.Entity({
              id: `tsunami-alert:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isHigh ? 0.48 : 0.34),
                outline: true,
                outlineColor: color.withAlpha(0.92),
                outlineWidth: isHigh ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                center: row.center,
                category: row.category,
                region: row.region,
                title: row.title,
                magnitude: row.magnitude,
                magnitudeRaw: row.magnitudeRaw,
                issuedAt: row.issuedAt,
                link: row.link,
              },
            }),
          );
          if (isHigh || row.category === 'Watch' || row.category === 'Information') {
            overlayEntries.push(createOverlayEntry(row, position));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            TSUNAMI_ALERTS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: TSUNAMI_ALERTS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: TSUNAMI_ALERTS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:TsunamiAlerts] Updated: ${count} bulletins`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:TsunamiAlerts] Fetch error:', error);
        lastError = error?.message || 'Tsunami alerts source unavailable';
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
      overlayHost.clearSource(TSUNAMI_ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(TSUNAMI_ALERTS_OVERLAY_SOURCE_ID, false);
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

export { createTsunamiAlertsSource } from './source.js';
export {
  normalizeTsunamiAtom,
  mergeTsunamiRows,
  parseTsunamiEntry,
  tsunamiCategoryColorCss,
  TSUNAMI_FEED_URLS,
  TSUNAMI_PAAQ_ATOM_URL,
  TSUNAMI_PHEB_ATOM_URL,
} from './parse.js';
