/**
 * FAA NAS airport delays — closures / ground stops / delays as ground points.
 * Events group toggle. Situational awareness only.
 */
import * as Cesium from 'cesium';
import {
  airportDelayColorCss,
  airportDelayRank,
} from './parse.js';
import { airportDelayLabel, buildAirportDelayCard } from './cards.js';

export const AIRPORT_DELAYS_LAYER_ID = 'airport-delays';
export const AIRPORT_DELAYS_OVERLAY_SOURCE_ID = 'airport-delays';
export const AIRPORT_DELAYS_OVERLAY_COHORT_LIMIT = 24;
export const AIRPORT_DELAYS_OVERLAY_COLLISION_CAPACITY = 16;

export { airportDelayLabel, buildAirportDelayCard } from './cards.js';

const PICK_PREFIX = 'airport-delay:';
/** Kinds that carry an ambient globe label (unchanged look: closures, and
 * the partial closures that FAA lists under "Airport Closures"). */
const LABELED_KINDS = new Set(['closure', 'restriction']);

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: airportDelayLabel(row),
    accent: airportDelayColorCss(row.kind),
    priority: 1000 + airportDelayRank(row.kind) * 1000,
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
    .slice(0, AIRPORT_DELAYS_OVERLAY_COHORT_LIMIT);
}

/** Build the FAA airport delays globe layer. */
export function createAirportDelaysLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Airport delays require a snapshot source');
  if (!overlayHost) throw new TypeError('Airport delays require an overlay host');

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
            ...buildAirportDelayCard(row),
            position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
          },
          ...labelEntries.filter((entry) => entry.id !== String(row.stableId)),
        ]
      : labelEntries;
    overlayHost.setEntries(AIRPORT_DELAYS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: AIRPORT_DELAYS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: AIRPORT_DELAYS_OVERLAY_COLLISION_CAPACITY,
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

  function installClickHandler() {
    if (!canSelect() || clickHandler || !viewer) return;
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const id = picked ? rowIdFromPick(picked) : null;
      if (id) {
        selectedId = id;
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
    id: AIRPORT_DELAYS_LAYER_ID,
    name: 'Airport Delays (FAA)',
    icon: '🛫',
    source: 'FAA NAS Status',
    updateInterval: 2.5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Airport delays layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(AIRPORT_DELAYS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(AIRPORT_DELAYS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(AIRPORT_DELAYS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      selectedId = null;
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(AIRPORT_DELAYS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIRPORT_DELAYS_OVERLAY_SOURCE_ID, false);
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
          const color = Cesium.Color.fromCssColorString(
            airportDelayColorCss(row.kind),
          );
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          // Partial closures keep the closure marker size (look unchanged).
          const isClosure = LABELED_KINDS.has(row.kind);
          const size = isClosure ? 12 : row.kind === 'ground_stop' ? 10 : 8;
          nextEntities.push(
            new Cesium.Entity({
              id: `airport-delay:${row.stableId}`,
              name: airportDelayLabel(row),
              position,
              point: {
                pixelSize: size,
                color: color.withAlpha(0.95),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
                outlineWidth: 1,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                arpt: row.arpt,
                icao: row.icao,
                kind: row.kind,
                delayType: row.delayType,
                reason: row.reason,
                start: row.start,
                reopen: row.reopen,
                end: row.end,
                startIso: row.startIso ?? null,
                endIso: row.endIso ?? null,
                name: row.name,
              },
            }),
          );
          if (LABELED_KINDS.has(row.kind))
            overlayEntries.push(createOverlayEntry(row, position));
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
        console.log(`[Data:AirportDelays] Updated: ${count} airports`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:AirportDelays] Fetch error:', error);
        lastError = error?.message || 'Airport delays source unavailable';
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
      overlayHost.clearSource(AIRPORT_DELAYS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIRPORT_DELAYS_OVERLAY_SOURCE_ID, false);
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

export { createAirportDelaysSource } from './source.js';
export {
  normalizeAirportDelays,
  parseAirportStatusXml,
  airportDelayKind,
  refineAirportDelayKind,
  parseNotamRange,
  airportDelayColorCss,
  arptToIcao,
  FAA_AIRPORT_STATUS_URL,
} from './parse.js';
