/**
 * Environment and Climate Change Canada public weather alerts — warning,
 * watch, advisory and statement regions draped on the globe and colored by
 * ECCC risk colour (yellow / orange / red), with a click card (type, impact,
 * confidence, area, summary, validity). Events group toggle; complements the
 * U.S.-only NWS alerts layer.
 */
import * as Cesium from 'cesium';
import { canadaAlertColorCss } from './parse.js';
import { canadaAlertLabel, buildCanadaAlertCard } from './cards.js';

export const CANADA_ALERTS_LAYER_ID = 'canada-alerts';
export const CANADA_ALERTS_OVERLAY_SOURCE_ID = 'canada-alerts';
export const CANADA_ALERTS_OVERLAY_COHORT_LIMIT = 20;
export const CANADA_ALERTS_OVERLAY_COLLISION_CAPACITY = 16;

export { canadaAlertLabel, buildCanadaAlertCard } from './cards.js';

const PICK_PREFIX = 'canada-alerts:';
/** Warnings and watches get floating labels. */
const LABEL_MIN_RANK = 2;

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: canadaAlertLabel(row),
    accent: canadaAlertColorCss(row),
    priority: 1000 + (Number(row.rank) || 0) * 1000,
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
    .slice(0, CANADA_ALERTS_OVERLAY_COHORT_LIMIT);
}

/** Build the ECCC Canada weather alerts globe layer. */
export function createCanadaAlertsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Canada alerts require a snapshot source');
  if (!overlayHost)
    throw new TypeError('Canada alerts require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let clickHandler = null;
  let selectedId = null;
  let labelEntries = [];
  const rowById = new Map();

  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);

  function publishOverlay() {
    if (!enabled) return;
    const row = selectedId ? rowById.get(selectedId) : null;
    if (!row) selectedId = null;
    const entries = row
      ? [
          {
            ...buildCanadaAlertCard(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          },
          ...labelEntries.filter((entry) => entry.id !== String(row.stableId)),
        ]
      : labelEntries;
    overlayHost.setEntries(CANADA_ALERTS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: CANADA_ALERTS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: CANADA_ALERTS_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  function rowIdFromPick(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length).split('#')[0];
    return rowById.has(id) ? id : null;
  }

  function bestRowAt(position, firstId) {
    let best = rowById.get(firstId);
    let picks = [];
    try {
      picks = viewer?.scene?.drillPick?.(position, 8) || [];
    } catch {
      picks = [];
    }
    for (const picked of picks) {
      const id = rowIdFromPick(picked);
      const row = id ? rowById.get(id) : null;
      if (!row) continue;
      if ((row.rank || 0) > (best.rank || 0)) best = row;
    }
    return String(best.stableId);
  }

  function installClickHandler() {
    if (!canSelect() || clickHandler || !viewer) return;
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const id = picked ? rowIdFromPick(picked) : null;
      if (id) {
        selectedId = bestRowAt(click.position, id);
        publishOverlay();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      }
      if (selectedId) {
        selectedId = null;
        publishOverlay();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (clickHandler) {
      clickHandler.destroy();
      clickHandler = null;
    }
  }

  const layer = {
    id: CANADA_ALERTS_LAYER_ID,
    name: 'Canada Weather Alerts (ECCC)',
    icon: '🍁',
    source: 'Environment and Climate Change Canada',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Canada alerts layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(CANADA_ALERTS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(CANADA_ALERTS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(CANADA_ALERTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      selectedId = null;
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(CANADA_ALERTS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CANADA_ALERTS_OVERLAY_SOURCE_ID, false);
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
          const rings = Array.isArray(row.rings) ? row.rings : [];
          if (!rings.length) continue;
          const color = Cesium.Color.fromCssColorString(canadaAlertColorCss(row));
          const strong = (row.rank || 0) >= 3;
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          rings.forEach((ring, part) => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            const flat = [];
            for (const [lon, lat] of ring) flat.push(lon, lat);
            const positions = Cesium.Cartesian3.fromDegreesArray(flat);
            nextEntities.push(
              new Cesium.Entity({
                id: `${PICK_PREFIX}${row.stableId}${part ? `#${part}` : ''}`,
                name: canadaAlertLabel(row),
                position: center,
                polyline: {
                  positions: [...positions, positions[0]],
                  width: strong ? 2.4 : 1.6,
                  material: color.withAlpha(0.9),
                  clampToGround: true,
                  classificationType: Cesium.ClassificationType.BOTH,
                },
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(positions),
                  material: color.withAlpha(strong ? 0.24 : 0.14),
                  classificationType: Cesium.ClassificationType.BOTH,
                },
                properties: {
                  type: row.type,
                  name: row.name,
                  area: row.area,
                  province: row.province,
                  risk: row.risk,
                  expires: row.expires,
                },
              }),
            );
          });
          if ((row.rank || 0) >= LABEL_MIN_RANK) {
            overlayEntries.push(createOverlayEntry(row, center));
          }
        }

        dataSource.entities.suspendEvents();
        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        dataSource.entities.resumeEvents();
        rowById.clear();
        for (const row of rows) {
          if (row?.stableId != null) rowById.set(String(row.stableId), row);
        }
        labelEntries = selectOverlayCohort(overlayEntries);
        if (enabled) publishOverlay();

        count = rows.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:CanadaAlerts] Updated: ${count} alert regions`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:CanadaAlerts] Fetch error:', error);
        lastError = error?.message || 'Canada alerts source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    getStatus() {
      return {
        id: CANADA_ALERTS_LAYER_ID,
        enabled,
        count,
        lastUpdate,
        lastError,
      };
    },

    getStats() {
      return { count, lastUpdate, lastError, enabled };
    },

    destroy() {
      this.disable();
      if (viewer && dataSource) {
        viewer.dataSources.remove(dataSource, true);
      }
      viewer = null;
      dataSource = null;
      count = 0;
      lastUpdate = null;
      lastError = null;
    },
  };

  return layer;
}

export { createCanadaAlertsSource } from './source.js';
export {
  normalizeCanadaAlerts,
  parseCanadaAlert,
  canadaAlertColorCss,
  ECCC_ALERTS_URL,
} from './parse.js';
