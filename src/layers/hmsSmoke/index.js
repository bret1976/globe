/**
 * NOAA HMS smoke plumes — Light/Medium/Heavy density polygons on the globe.
 */
import * as Cesium from 'cesium';
import { hmsSmokeColorCss, hmsSmokeRank } from './parse.js';
import { hmsSmokeLabel, buildHmsSmokeCard } from './cards.js';

export const HMS_SMOKE_LAYER_ID = 'hms-smoke';
export const HMS_SMOKE_OVERLAY_SOURCE_ID = 'hms-smoke';
export const HMS_SMOKE_OVERLAY_COHORT_LIMIT = 16;
export const HMS_SMOKE_OVERLAY_COLLISION_CAPACITY = 12;

export { hmsSmokeLabel, buildHmsSmokeCard } from './cards.js';

const PICK_PREFIX = 'hms-smoke:';
const LABELED = new Set(['MEDIUM', 'HEAVY']);

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: hmsSmokeLabel(row),
    accent: hmsSmokeColorCss(row.density),
    priority: 800 + hmsSmokeRank(row.density) * 1000,
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
    .slice(0, HMS_SMOKE_OVERLAY_COHORT_LIMIT);
}

export function createHmsSmokeLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('HMS smoke requires a snapshot source');
  if (!overlayHost) throw new TypeError('HMS smoke requires an overlay host');

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
            ...buildHmsSmokeCard(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          },
          ...labelEntries.filter((entry) => entry.id !== String(row.stableId)),
        ]
      : labelEntries;
    overlayHost.setEntries(HMS_SMOKE_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: HMS_SMOKE_OVERLAY_COHORT_LIMIT,
      collisionCapacity: HMS_SMOKE_OVERLAY_COLLISION_CAPACITY,
      moving: false,
    });
  }

  function rowIdFromPick(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const id = pickId.slice(PICK_PREFIX.length);
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
      if (hmsSmokeRank(row.density) > hmsSmokeRank(best.density)) best = row;
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
    id: HMS_SMOKE_LAYER_ID,
    name: 'Smoke Plumes (NOAA HMS)',
    icon: '🌫️',
    source: 'NOAA NESDIS Hazard Mapping System',
    updateInterval: 30 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('HMS smoke layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(HMS_SMOKE_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(HMS_SMOKE_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(HMS_SMOKE_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      selectedId = null;
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(HMS_SMOKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(HMS_SMOKE_OVERLAY_SOURCE_ID, false);
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
            hmsSmokeColorCss(row.density),
          );
          const rank = hmsSmokeRank(row.density);
          const strong = rank >= 2;
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const entity = new Cesium.Entity({
            id: `hms-smoke:${row.stableId}`,
            name: hmsSmokeLabel(row),
            position: center,
            polyline: {
              positions: [...positions, positions[0]],
              width: strong ? 2 : 1.4,
              material: color.withAlpha(0.85),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              material: color.withAlpha(strong ? 0.28 : 0.16),
              classificationType: Cesium.ClassificationType.BOTH,
            },
            properties: {
              density: row.density,
              satellite: row.satellite,
              start: row.start,
              end: row.end,
            },
          });
          nextEntities.push(entity);
          if (LABELED.has(String(row.density || '').toUpperCase())) {
            overlayEntries.push(createOverlayEntry(row, center));
          }
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        rowById.clear();
        for (const row of rows) {
          if (row?.stableId != null) rowById.set(String(row.stableId), row);
        }
        labelEntries = selectOverlayCohort(overlayEntries);
        if (enabled) publishOverlay();

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:HmsSmoke] Updated: ${count} plumes`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:HmsSmoke] Fetch error:', error);
        lastError = error?.message || 'HMS smoke source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    getStatus() {
      return {
        id: HMS_SMOKE_LAYER_ID,
        enabled,
        count,
        lastUpdate,
        lastError,
      };
    },

    destroy() {
      this.disable();
      if (viewer && dataSource) {
        viewer.dataSources.remove(dataSource, true);
      }
      viewer = null;
      dataSource = null;
    },
  };

  return layer;
}

export { createHmsSmokeSource } from './source.js';
