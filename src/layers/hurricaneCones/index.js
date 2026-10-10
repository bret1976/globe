/**
 * Hurricane Cones (NHC) — official forecast cone, track and forecast points
 * for active Atlantic / East + Central Pacific storms. Tap a cone, track or
 * point for the storm card (same world-overlay card as Fire Perimeters).
 *
 * Data layer ported from bilawalsidhu/gods-eye-view v0.2.0 (MIT, © 2026
 * Bilawal Sidhu) cyclone cones; rendering follows GodsEye's perimeter layer.
 */
import * as Cesium from 'cesium';
import {
  HURRICANE_CONES_OVERLAY_SOURCE_ID,
  buildHurricaneCard,
  stormAccent,
} from './cards.js';

export const HURRICANE_CONES_LAYER_ID = 'hurricane-cones';
export { createHurricaneConesSource } from './source.js';
export * from './cards.js';

const PICK_PREFIX = 'hurricane-cones:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

const toPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/** Own the NHC cone display, refresh lifecycle, and tap selection. */
export function createHurricaneConesLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Hurricane cones require a snapshot source');
  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let clickHandler = null;
  let signature = null;
  let selected = null; // { stormId, tau }
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  /** @type {Map<string, object>} */
  const rowById = new Map();

  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);

  function publishCard() {
    if (!overlayHost) return;
    const row = selected ? rowById.get(selected.stormId) : null;
    if (!row) {
      selected = null;
      overlayHost.setEntries(
        HURRICANE_CONES_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const point =
      selected.tau == null
        ? null
        : row.points.find((p) => p.tau === selected.tau) || null;
    const at = point || row.anchor;
    overlayHost.setEntries(
      HURRICANE_CONES_OVERLAY_SOURCE_ID,
      [
        {
          ...buildHurricaneCard(row, point),
          position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
        },
      ],
      CARD_HOST_OPTIONS,
    );
  }

  /** `hurricane-cones:<storm>:<kind>:<n>` → { stormId, tau } or null. */
  function pickedTarget(picked) {
    const pickId = picking.resolvePickId(picked);
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [stormId, kind, n] = pickId.slice(PICK_PREFIX.length).split(':');
    if (!rowById.has(stormId)) return null;
    return { stormId, tau: kind === 'point' ? Number(n) : null };
  }

  function installClickHandler() {
    if (!canSelect() || clickHandler || !viewer) return;
    // Like fire perimeters: not registered as a pick owner, so large cones
    // never make sibling layers' cards inert.
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const target = picked ? pickedTarget(picked) : null;
      if (target) {
        selected = target;
        publishCard();
        return;
      }
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer?.(layer.id, pickId)) return;
      }
      if (selected) {
        selected = null;
        publishCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    clickHandler?.destroy();
    clickHandler = null;
  }

  function clearSelection() {
    selected = null;
    if (overlayHost) {
      overlayHost.clearSource(HURRICANE_CONES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(HURRICANE_CONES_OVERLAY_SOURCE_ID, false);
    }
  }

  function buildEntities(rows) {
    const entities = [];
    for (const row of rows) {
      const color = Cesium.Color.fromCssColorString(
        stormAccent(row.current?.maxWindKt),
      );
      row.cones.forEach((ring, index) => {
        const positions = toPositions(ring);
        entities.push(
          new Cesium.Entity({
            id: `${PICK_PREFIX}${row.stableId}:cone:${index}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions),
              material: new Cesium.ColorMaterialProperty(
                Cesium.Color.WHITE.withAlpha(0.16),
              ),
            },
            polyline: {
              positions,
              clampToGround: true,
              width: 2,
              material: new Cesium.ColorMaterialProperty(
                Cesium.Color.WHITE.withAlpha(0.75),
              ),
            },
          }),
        );
      });
      row.tracks.forEach((line, index) => {
        entities.push(
          new Cesium.Entity({
            id: `${PICK_PREFIX}${row.stableId}:track:${index}`,
            polyline: {
              positions: toPositions(line),
              clampToGround: true,
              width: 3,
              material: new Cesium.PolylineDashMaterialProperty({
                color: color.withAlpha(0.95),
                dashLength: 14,
              }),
            },
          }),
        );
      });
      for (const point of row.points) {
        const now = point.tau === 0;
        entities.push(
          new Cesium.Entity({
            id: `${PICK_PREFIX}${row.stableId}:point:${point.tau}`,
            position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
            point: {
              pixelSize: now ? 13 : 8,
              color: Cesium.Color.fromCssColorString(
                stormAccent(point.maxWindKt),
              ),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: now ? 2 : 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            ...(now
              ? {
                  label: {
                    text: `${row.name} · ${row.category}`,
                    font: '12px JetBrains Mono, monospace',
                    fillColor: Cesium.Color.WHITE,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 3,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -18),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    showBackground: true,
                    backgroundColor: Cesium.Color.BLACK.withAlpha(0.4),
                  },
                }
              : {}),
          }),
        );
      }
    }
    return entities;
  }

  const layer = {
    id: HURRICANE_CONES_LAYER_ID,
    name: 'Hurricane Cones',
    icon: '🌀',
    source: 'NOAA NHC · forecast cone',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Hurricane cones layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(HURRICANE_CONES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost?.setVisible?.(HURRICANE_CONES_OVERLAY_SOURCE_ID, true);
      installClickHandler();
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      try {
        const payload = await source.getSnapshot({ signal: current.signal });
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        const rows = payload.rows;
        const nextSignature = JSON.stringify(
          rows.map((row) => [row.stableId, row.advisory, row.points.length]),
        );
        if (nextSignature !== signature) {
          // Plain removeAll + add (no suspendEvents batching with reused
          // ids): a reload never leaves a stale cone behind.
          const entities = buildEntities(rows);
          dataSource.entities.removeAll();
          for (const entity of entities) dataSource.entities.add(entity);
          rowById.clear();
          for (const row of rows) rowById.set(row.stableId, row);
          signature = nextSignature;
        }
        if (selected) publishCard();
        count = rows.length;
        lastUpdate = Date.now();
        lastError = payload.stale ? 'Showing last good NHC advisory' : null;
        console.log(`[Data:HurricaneCones] Updated: ${count} storms`);
        return true;
      } catch (error) {
        if (current.signal.aborted || request !== current || !enabled)
          return false;
        console.warn('[Data:HurricaneCones] Fetch error:', error);
        lastError = error?.message || 'NHC cones unavailable';
        return false;
      } finally {
        if (request === current) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      removeClickHandler();
      clearSelection();
      rowById.clear();
      signature = null;
      enabled = false;
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      viewer = null;
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getAnalystRecords(maxCount = 200) {
      if (!dataSource?.show) return [];
      return [...rowById.values()].slice(0, maxCount).map((row) => ({
        id: row.stableId,
        name: row.name,
        basin: row.basin,
        category: row.category,
        maxWindKt: row.current?.maxWindKt ?? null,
        advisory: row.advisory,
        lat: row.anchor.lat,
        lon: row.anchor.lon,
      }));
    },

    getStats() {
      return { count, lastUpdate, error: lastError };
    },
  };
  return layer;
}
