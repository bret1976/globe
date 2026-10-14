/**
 * NOAA Coral Reef Watch — reef regions worldwide (Daily 5km Regional Virtual
 * Stations) draped on the globe and colored by bleaching heat-stress alert
 * level (No Stress → Alert Level 2), with a marker disc at each station and a
 * click card (DHW, HotSpot, SST anomaly, 7-day trend). Events group toggle.
 */
import * as Cesium from 'cesium';
import { coralAlertColorCss } from './parse.js';
import { coralStationLabel, buildCoralCard } from './cards.js';

export const CORAL_BLEACHING_LAYER_ID = 'coral-bleaching';
export const CORAL_BLEACHING_OVERLAY_SOURCE_ID = 'coral-bleaching';
export const CORAL_BLEACHING_OVERLAY_COHORT_LIMIT = 24;
export const CORAL_BLEACHING_OVERLAY_COLLISION_CAPACITY = 18;

export { coralStationLabel, buildCoralCard } from './cards.js';

const PICK_PREFIX = 'coral-bleaching:';
/** Alert Level 1+ stations get floating labels. */
const LABEL_MIN_LEVEL = 3;
/** Marker disc radius by alert level (meters). */
const RADIUS_BY_LEVEL = Object.freeze([22_000, 28_000, 34_000, 42_000, 52_000]);

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: coralStationLabel(row),
    accent: coralAlertColorCss(row.level),
    priority: 1000 + (Number(row.level) || 0) * 1000 + Math.min(999, Math.round((row.dhw || 0) * 10)),
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
    .slice(0, CORAL_BLEACHING_OVERLAY_COHORT_LIMIT);
}

/** Build the NOAA Coral Reef Watch globe layer. */
export function createCoralBleachingLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Coral bleaching requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('Coral bleaching requires an overlay host');

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
            ...buildCoralCard(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          },
          ...labelEntries.filter((entry) => entry.id !== String(row.stableId)),
        ]
      : labelEntries;
    overlayHost.setEntries(CORAL_BLEACHING_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: CORAL_BLEACHING_OVERLAY_COHORT_LIMIT,
      collisionCapacity: CORAL_BLEACHING_OVERLAY_COLLISION_CAPACITY,
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
      if ((row.level || 0) > (best.level || 0)) best = row;
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
    id: CORAL_BLEACHING_LAYER_ID,
    name: 'Coral Bleaching (NOAA CRW)',
    icon: '🪸',
    source: 'NOAA Coral Reef Watch',
    updateInterval: 60 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Coral bleaching layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(CORAL_BLEACHING_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(CORAL_BLEACHING_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(CORAL_BLEACHING_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      selectedId = null;
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(CORAL_BLEACHING_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CORAL_BLEACHING_OVERLAY_SOURCE_ID, false);
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
          const level = Math.max(0, Math.min(4, Number(row.level) || 0));
          const color = Cesium.Color.fromCssColorString(
            coralAlertColorCss(level),
          );
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const radiusM = RADIUS_BY_LEVEL[level];
          const hot = level >= 3;
          nextEntities.push(
            new Cesium.Entity({
              id: `${PICK_PREFIX}${row.stableId}`,
              name: coralStationLabel(row),
              position: center,
              ellipse: {
                semiMajorAxis: radiusM,
                semiMinorAxis: radiusM,
                material: color.withAlpha(hot ? 0.55 : 0.38),
                outline: true,
                outlineColor: color.withAlpha(0.95),
                outlineWidth: hot ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                name: row.name,
                level,
                dhw: row.dhw,
                hotspot: row.hotspot,
                sst: row.sst,
                ssta: row.ssta,
                trend: row.trend,
                date: row.date,
              },
            }),
          );
          const rings = Array.isArray(row.rings) ? row.rings : [];
          rings.forEach((ring, part) => {
            if (!Array.isArray(ring) || ring.length < 3) return;
            const flat = [];
            for (const [lon, lat] of ring) flat.push(lon, lat);
            const positions = Cesium.Cartesian3.fromDegreesArray(flat);
            nextEntities.push(
              new Cesium.Entity({
                id: `${PICK_PREFIX}${row.stableId}#${part}`,
                polyline: {
                  positions: [...positions, positions[0]],
                  width: hot ? 2.2 : 1.4,
                  material: color.withAlpha(0.85),
                  clampToGround: true,
                  classificationType: Cesium.ClassificationType.BOTH,
                },
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(positions),
                  material: color.withAlpha(hot ? 0.28 : 0.14),
                  classificationType: Cesium.ClassificationType.BOTH,
                },
              }),
            );
          });
          if (level >= LABEL_MIN_LEVEL) {
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
        console.log(`[Data:CoralBleaching] Updated: ${count} reef stations`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:CoralBleaching] Fetch error:', error);
        lastError = error?.message || 'Coral bleaching source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    getStatus() {
      return {
        id: CORAL_BLEACHING_LAYER_ID,
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

export { createCoralBleachingSource } from './source.js';
export {
  normalizeCoralStations,
  coralAlertLevel,
  coralAlertColorCss,
  CRW_VS_URL,
} from './parse.js';
