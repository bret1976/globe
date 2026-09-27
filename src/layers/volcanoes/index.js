/**
 * USGS elevated volcanoes layer — alert-level colored discs on the globe.
 * Yellow = Advisory, Orange = Watch, Red = Warning.
 */
import * as Cesium from 'cesium';
import { volcanoColorCss } from './parse.js';

export const VOLCANOES_LAYER_ID = 'volcanoes';
export const VOLCANOES_OVERLAY_SOURCE_ID = 'volcanoes';
export const VOLCANOES_OVERLAY_COHORT_LIMIT = 32;
export const VOLCANOES_OVERLAY_COLLISION_CAPACITY = 24;

const RADIUS_BY_COLOR = Object.freeze({
  RED: 55_000,
  ORANGE: 42_000,
  YELLOW: 32_000,
  GREEN: 25_000,
});

function colorFor(code) {
  return Cesium.Color.fromCssColorString(volcanoColorCss(code));
}

function createOverlayEntry(row, position) {
  const accent = volcanoColorCss(row.colorCode);
  const title = `${row.name} · ${row.colorCode}/${row.alertLevel || 'ALERT'}`;
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title,
    accent,
    priority:
      row.colorCode === 'RED'
        ? 4000
        : row.colorCode === 'ORANGE'
          ? 3000
          : 2000,
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
    .slice(0, VOLCANOES_OVERLAY_COHORT_LIMIT);
}

/** Build the elevated-volcanoes globe layer. */
export function createVolcanoesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Volcanoes require a snapshot source');
  if (!overlayHost) throw new TypeError('Volcanoes require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: VOLCANOES_LAYER_ID,
    name: 'Volcanoes (elevated)',
    icon: '🌋',
    source: 'USGS Volcano Hazards',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Volcanoes layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(VOLCANOES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(VOLCANOES_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(VOLCANOES_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(VOLCANOES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VOLCANOES_OVERLAY_SOURCE_ID, false);
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
          const color = colorFor(row.colorCode);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = RADIUS_BY_COLOR[row.colorCode] || RADIUS_BY_COLOR.YELLOW;
          const isHigh = row.colorCode === 'RED' || row.colorCode === 'ORANGE';
          nextEntities.push(
            new Cesium.Entity({
              id: `volcano:${row.stableId}`,
              position,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(isHigh ? 0.42 : 0.32),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                outlineWidth: isHigh ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                vnum: row.vnum,
                name: row.name,
                colorCode: row.colorCode,
                alertLevel: row.alertLevel,
                obs: row.obs,
                synopsis: row.synopsis,
                noticeUrl: row.noticeUrl,
                sentUtc: row.sentUtc,
                threat: row.threat,
              },
            }),
          );
          overlayEntries.push(createOverlayEntry(row, position));
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            VOLCANOES_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: VOLCANOES_OVERLAY_COHORT_LIMIT,
              collisionCapacity: VOLCANOES_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:Volcanoes] Updated: ${count} elevated`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Volcanoes] Fetch error:', error);
        lastError = error?.message || 'Volcano source unavailable';
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
      overlayHost.clearSource(VOLCANOES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(VOLCANOES_OVERLAY_SOURCE_ID, false);
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getStats() {
      return {
        count,
        lastUpdate,
        lastError,
        enabled,
      };
    },
  };

  return layer;
}
