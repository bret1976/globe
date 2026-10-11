/**
 * NOAA/NWS SPC convective outlook — Day 1/2 categorical risk polygons draped
 * on the globe, colored by LABEL tier. Weather group toggle.
 */
import * as Cesium from 'cesium';
import {
  spcOutlookColorCss,
  spcOutlookRank,
  LABELED_SPC_LABELS,
} from './parse.js';
import { spcOutlookLabel, buildSpcOutlookCard } from './cards.js';

export const SPC_OUTLOOK_LAYER_ID = 'spc-outlook';
export const SPC_OUTLOOK_OVERLAY_SOURCE_ID = 'spc-outlook';
export const SPC_OUTLOOK_OVERLAY_COHORT_LIMIT = 24;
export const SPC_OUTLOOK_OVERLAY_COLLISION_CAPACITY = 16;

export { spcOutlookLabel, buildSpcOutlookCard } from './cards.js';

const PICK_PREFIX = 'spc-outlook:';

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: spcOutlookLabel(row),
    accent: spcOutlookColorCss(row.label),
    priority: 1000 + spcOutlookRank(row.label) * 1000 + (row.day === 1 ? 50 : 0),
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
    .slice(0, SPC_OUTLOOK_OVERLAY_COHORT_LIMIT);
}

/** Build the SPC convective outlook globe layer. */
export function createSpcOutlookLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('SPC outlook requires a snapshot source');
  if (!overlayHost) throw new TypeError('SPC outlook requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let clickHandler = null;
  let selectedId = null;
  /** @type {Array<object>} ambient label entries from the last update */
  let labelEntries = [];
  /** @type {Map<string, object>} stableId → row */
  const rowById = new Map();

  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);

  /** Publish ambient labels plus (when selected) the info card. */
  function publishOverlay() {
    if (!enabled) return;
    const row = selectedId ? rowById.get(selectedId) : null;
    if (!row) selectedId = null;
    const entries = row
      ? [
          {
            ...buildSpcOutlookCard(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          },
          ...labelEntries.filter((entry) => entry.id !== String(row.stableId)),
        ]
      : labelEntries;
    overlayHost.setEntries(SPC_OUTLOOK_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: SPC_OUTLOOK_OVERLAY_COHORT_LIMIT,
      collisionCapacity: SPC_OUTLOOK_OVERLAY_COLLISION_CAPACITY,
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

  /** Stacked tiers overlap: prefer the highest risk under the tap, Day 1 first. */
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
      const better =
        spcOutlookRank(row.label) - spcOutlookRank(best.label) ||
        best.day - row.day;
      if (better > 0) best = row;
    }
    return String(best.stableId);
  }

  function installClickHandler() {
    if (!canSelect() || clickHandler || !viewer) return;
    // Like fire perimeters: large ground polygons are deliberately NOT
    // registered as pick owners, so sibling layers' cards stay tappable.
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
    id: SPC_OUTLOOK_LAYER_ID,
    name: 'SPC Outlook (NOAA)',
    icon: '⛈️',
    source: 'NOAA/NWS Storm Prediction Center',
    updateInterval: 15 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('SPC outlook layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(SPC_OUTLOOK_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(SPC_OUTLOOK_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(SPC_OUTLOOK_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      selectedId = null;
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(SPC_OUTLOOK_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(SPC_OUTLOOK_OVERLAY_SOURCE_ID, false);
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
            spcOutlookColorCss(row.label),
          );
          const rank = spcOutlookRank(row.label);
          const strong = rank >= 4;
          const center = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const entity = new Cesium.Entity({
            id: `spc-outlook:${row.stableId}`,
            name: spcOutlookLabel(row),
            position: center,
            polyline: {
              positions: [...positions, positions[0]],
              width: strong ? 2.5 : 1.5,
              material: color.withAlpha(0.9),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              material: color.withAlpha(strong ? 0.22 : 0.14),
              classificationType: Cesium.ClassificationType.BOTH,
            },
            properties: {
              day: row.day,
              label: row.label,
              label2: row.label2,
              dn: row.dn,
              issue: row.issue,
              valid: row.valid,
            },
          });
          nextEntities.push(entity);
          if (LABELED_SPC_LABELS.has(String(row.label || '').toUpperCase())) {
            overlayEntries.push(createOverlayEntry(row, center));
          }
        }

        // No suspendEvents() here: inside a suspended batch, removeAll() +
        // add() of the SAME ids cancel out, so visualizers keep drawing the
        // previous Entity objects — which then ignore dataSource.show and
        // linger after toggle-off. Unsuspended, each swap is a real
        // remove/add (as in Airport Delays).
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
        console.log(`[Data:SpcOutlook] Updated: ${count} polygons`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:SpcOutlook] Fetch error:', error);
        lastError = error?.message || 'SPC outlook source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      removeClickHandler();
      selectedId = null;
      labelEntries = [];
      rowById.clear();
      viewer = null;
      enabled = false;
      overlayHost.clearSource(SPC_OUTLOOK_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(SPC_OUTLOOK_OVERLAY_SOURCE_ID, false);
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

export { createSpcOutlookSource } from './source.js';
export {
  normalizeSpcOutlook,
  parseSpcOutlookFeature,
  spcOutlookColorCss,
  spcOutlookRank,
  SPC_DAY1_CAT_URL,
  SPC_DAY2_CAT_URL,
  LABELED_SPC_LABELS,
} from './parse.js';
