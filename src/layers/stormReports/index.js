/**
 * NWS local storm reports — discs colored by report kind (tornado, hail, wind, flood…).
 * Severity (type + magnitude) drives size; Events group toggle.
 */
import * as Cesium from 'cesium';
import { stormReportColorCss } from './parse.js';

export const STORM_REPORTS_LAYER_ID = 'storm-reports';
export const STORM_REPORTS_OVERLAY_SOURCE_ID = 'storm-reports';
export const STORM_REPORTS_OVERLAY_COHORT_LIMIT = 36;
export const STORM_REPORTS_OVERLAY_COLLISION_CAPACITY = 24;

const RADIUS_BY_RANK = Object.freeze({
  4: 30_000,
  3: 24_000,
  2: 19_000,
  1: 14_000,
  0: 12_000,
});

function colorFor(kind) {
  return Cesium.Color.fromCssColorString(stormReportColorCss(kind));
}

function formatLabel(row) {
  const type = String(row.type || '').toLowerCase();
  const bits = [type.charAt(0).toUpperCase() + type.slice(1)];
  if (Number.isFinite(row.magnitude) && row.magnitude > 0)
    bits.push(`${row.magnitude}${row.unit ? ` ${String(row.unit).toLowerCase()}` : ''}`);
  const where = [row.city, row.state].filter(Boolean).join(', ');
  if (where) bits.push(where);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatLabel(row),
    accent: stormReportColorCss(row.kind),
    priority:
      1000 +
      (Number(row.intensityRank) || 0) * 1000 +
      Math.min(999, Number(row.magnitude) || 0),
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
    .slice(0, STORM_REPORTS_OVERLAY_COHORT_LIMIT);
}

/** Build the NWS local storm reports globe layer. */
export function createStormReportsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Storm reports requires a snapshot source');
  if (!overlayHost) throw new TypeError('Storm reports requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: STORM_REPORTS_LAYER_ID,
    name: 'Storm Reports (NWS)',
    icon: '⛈️',
    source: 'NWS Local Storm Reports (IEM)',
    updateInterval: 10 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Storm reports layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(STORM_REPORTS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(STORM_REPORTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(STORM_REPORTS_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(STORM_REPORTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(STORM_REPORTS_OVERLAY_SOURCE_ID, false);
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
          const rank = Number(row.intensityRank) || 0;
          const color = colorFor(row.kind);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = RADIUS_BY_RANK[rank] ?? RADIUS_BY_RANK[0];
          const isBad = rank >= 3;
          nextEntities.push(
            new Cesium.Entity({
              id: `storm-report:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isBad ? 0.45 : 0.3),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: isBad ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                type: row.type,
                kind: row.kind,
                magnitude: row.magnitude,
                unit: row.unit,
                city: row.city,
                county: row.county,
                state: row.state,
                wfo: row.wfo,
                reporter: row.reporter,
                remark: row.remark,
                observedAt: row.observedAt,
                intensityRank: rank,
              },
            }),
          );
          if (rank >= 3) overlayEntries.push(createOverlayEntry(row, position));
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            STORM_REPORTS_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: STORM_REPORTS_OVERLAY_COHORT_LIMIT,
              collisionCapacity: STORM_REPORTS_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:StormReports] Updated: ${count} reports`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:StormReports] Fetch error:', error);
        lastError = error?.message || 'Storm reports source unavailable';
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
      overlayHost.clearSource(STORM_REPORTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(STORM_REPORTS_OVERLAY_SOURCE_ID, false);
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

export { createStormReportsSource } from './source.js';
export {
  normalizeStormReports,
  parseStormReport,
  stormReportKind,
  stormReportRank,
  stormReportColorCss,
  STORM_REPORTS_URL,
} from './parse.js';
