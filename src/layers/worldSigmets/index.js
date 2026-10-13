/**
 * AWC international SIGMETs — volcanic ash, tropical cyclone, thunderstorm,
 * turbulence and icing outlines worldwide, draped on the globe and colored by
 * hazard family. Events group toggle. Distinct from domestic `aviation-hazards`.
 * Situational awareness only — not for flight planning.
 */
import * as Cesium from 'cesium';
import { worldSigmetColorCss, worldSigmetRank } from './parse.js';
import { worldSigmetLabel, buildWorldSigmetCard } from './cards.js';

export const WORLD_SIGMETS_LAYER_ID = 'world-sigmets';
export const WORLD_SIGMETS_OVERLAY_SOURCE_ID = 'world-sigmets';
export const WORLD_SIGMETS_OVERLAY_COHORT_LIMIT = 28;
export const WORLD_SIGMETS_OVERLAY_COLLISION_CAPACITY = 20;

export { worldSigmetLabel, buildWorldSigmetCard } from './cards.js';

const PICK_PREFIX = 'world-sigmets:';
/** Families that get floating labels (most consequential / rarest). */
const LABELED = new Set(['ash', 'cyclone', 'convective']);
const STRONG = new Set(['ash', 'cyclone']);

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: worldSigmetLabel(row),
    accent: worldSigmetColorCss(row.family || row.hazard),
    priority: 1000 + worldSigmetRank(row.family) * 1000,
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
    .slice(0, WORLD_SIGMETS_OVERLAY_COHORT_LIMIT);
}

/** Build the AWC international SIGMET globe layer. */
export function createWorldSigmetsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('World SIGMETs require a snapshot source');
  if (!overlayHost)
    throw new TypeError('World SIGMETs require an overlay host');

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
            ...buildWorldSigmetCard(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          },
          ...labelEntries.filter((entry) => entry.id !== String(row.stableId)),
        ]
      : labelEntries;
    overlayHost.setEntries(WORLD_SIGMETS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: WORLD_SIGMETS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: WORLD_SIGMETS_OVERLAY_COLLISION_CAPACITY,
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
      if (worldSigmetRank(row.family) > worldSigmetRank(best.family))
        best = row;
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
    id: WORLD_SIGMETS_LAYER_ID,
    name: 'World SIGMETs (AWC)',
    icon: '🌋',
    source: 'Aviation Weather Center',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('World SIGMETs layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(WORLD_SIGMETS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(WORLD_SIGMETS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(WORLD_SIGMETS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      selectedId = null;
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(WORLD_SIGMETS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(WORLD_SIGMETS_OVERLAY_SOURCE_ID, false);
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
            worldSigmetColorCss(row.family || row.hazard),
          );
          const isArea = row.geometryType !== 'line' && row.ring.length >= 3;
          const strong = STRONG.has(row.family);
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const entity = new Cesium.Entity({
            id: `${PICK_PREFIX}${row.stableId}`,
            name: worldSigmetLabel(row),
            position: center,
            polyline: {
              positions: isArea ? [...positions, positions[0]] : positions,
              width: strong ? 3 : 1.8,
              material: color.withAlpha(0.9),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
            properties: {
              product: row.product,
              hazard: row.hazard,
              family: row.family,
              fir: row.fir,
              seriesId: row.seriesId,
              qualifier: row.qualifier,
              validFrom: row.validFrom,
              validTo: row.validTo,
              top: row.top,
              base: row.base,
              raw: row.raw,
            },
          });
          if (isArea) {
            entity.polygon = {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              material: color.withAlpha(strong ? 0.3 : 0.16),
              classificationType: Cesium.ClassificationType.BOTH,
            };
          }
          nextEntities.push(entity);
          if (LABELED.has(row.family)) {
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

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:WorldSigmets] Updated: ${count} outlines`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:WorldSigmets] Fetch error:', error);
        lastError = error?.message || 'World SIGMETs source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    getStatus() {
      return {
        id: WORLD_SIGMETS_LAYER_ID,
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

export { createWorldSigmetsSource } from './source.js';
export {
  normalizeWorldSigmets,
  parseWorldSigmet,
  worldSigmetFamily,
  worldSigmetColorCss,
  AWC_ISIGMET_URL,
} from './parse.js';
