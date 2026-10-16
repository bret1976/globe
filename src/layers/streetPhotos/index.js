/**
 * Street Photos — keyless street-level pictures from Panoramax, the open
 * federated street-level commons (api.panoramax.xyz meta-catalogue).
 *
 * Below DOTS_BELOW_M the pictures in view draw as orange dots; clicking one
 * opens it in the Street Photos viewer (caption, licence, ‹ › along its
 * sequence). The STAC policy/source are ported from upstream
 * bilawalsidhu/gods-eye-view PR #1134 (MIT); the layer and viewer are a
 * GodsEye adaptation (no Street Level provider framework here).
 */
import * as Cesium from 'cesium';
import { createPanoramaxSource } from './panoramax/source.js';
import {
  COLORS,
  NO_COVERAGE_HINT,
  OVERVIEW_HINT,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  normalizeItem,
} from './panoramax/policy.js';
import { createPhotoViewer } from './viewer.js';

export const STREET_PHOTOS_LAYER_ID = 'street-photos';
/** Dots draw only below this camera height. */
export const DOTS_BELOW_M = 6_000;
/** Search box half-size cap (m) around the view centre. */
export const MAX_BOX_HALF_M = 2_500;
export const DOT_LIMIT = 100;
export const MOVE_DEBOUNCE_MS = 400;

const DEG = 180 / Math.PI;

/**
 * Lon/lat search box for a view: the view rectangle, clipped to
 * ±MAX_BOX_HALF_M around the centre (or that box alone without a rectangle).
 */
export function searchBoxFor({
  lon,
  lat,
  rect = null,
  halfM = MAX_BOX_HALF_M,
}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const dLat = halfM / 111_320;
  const dLon =
    halfM / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  let box = {
    west: lon - dLon,
    south: lat - dLat,
    east: lon + dLon,
    north: lat + dLat,
  };
  if (
    rect &&
    [rect.west, rect.south, rect.east, rect.north].every(Number.isFinite) &&
    rect.west < rect.east
  ) {
    box = {
      west: Math.max(box.west, rect.west),
      south: Math.max(box.south, rect.south),
      east: Math.min(box.east, rect.east),
      north: Math.min(box.north, rect.north),
    };
  }
  return box.west < box.east && box.south < box.north ? box : null;
}

/** Picture id from a picked dot, or null. */
export function pictureIdFromPick(picked) {
  const id = picked?.id;
  return typeof id === 'string' && id.startsWith(PICK_PREFIX.image)
    ? id.slice(PICK_PREFIX.image.length)
    : null;
}

export function createStreetPhotosLayer({
  source = createPanoramaxSource(),
  createViewer = createPhotoViewer,
} = {}) {
  let viewer = null;
  let points = null;
  let handler = null;
  let photoViewer = null;
  let removeMoveEnd = null;
  let enabled = false;
  let request = null;
  let debounce = null;
  let selectedId = null;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let hint = null;
  const items = new Map();

  function cameraView() {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    let centre = null;
    const canvas = viewer.scene.canvas;
    const mid = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const ray = viewer.camera.getPickRay(mid);
    const hit = ray && viewer.scene.globe?.pick?.(ray, viewer.scene);
    if (hit) centre = Cesium.Cartographic.fromCartesian(hit);
    const c = centre || carto;
    const r = viewer.camera.computeViewRectangle?.();
    return {
      height: carto.height,
      lon: c.longitude * DEG,
      lat: c.latitude * DEG,
      rect: r
        ? {
            west: r.west * DEG,
            south: r.south * DEG,
            east: r.east * DEG,
            north: r.north * DEG,
          }
        : null,
    };
  }

  function styleDots() {
    if (!points) return;
    const base = Cesium.Color.fromCssColorString(COLORS.coverage);
    const sel = Cesium.Color.fromCssColorString(COLORS.selected);
    for (let i = 0; i < points.length; i++) {
      const p = points.get(i);
      const on = p.id === PICK_PREFIX.image + selectedId;
      p.color = on ? sel : base;
      p.pixelSize = on ? 12 : 8;
    }
  }

  function drawDots(list) {
    points.removeAll();
    const globe = viewer.scene.globe;
    for (const pose of list) {
      const carto = Cesium.Cartographic.fromDegrees(pose.lon, pose.lat);
      const h = globe?.getHeight?.(carto) ?? 0;
      points.add({
        id: PICK_PREFIX.image + pose.id,
        position: Cesium.Cartesian3.fromDegrees(
          pose.lon,
          pose.lat,
          (Number.isFinite(h) ? h : 0) + 2,
        ),
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString(COLORS.coverage),
        outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    styleDots();
    viewer.scene.requestRender?.();
  }

  async function refresh() {
    // Only a failed lookup is a failed update: an empty or skipped refresh
    // is a healthy state for the lifecycle.
    if (!enabled || !viewer || !points) return true;
    const view = cameraView();
    if (!view) return true;
    if (view.height > DOTS_BELOW_M) {
      request?.abort();
      points.removeAll();
      count = 0;
      hint = OVERVIEW_HINT;
      viewer.scene.requestRender?.();
      return true;
    }
    const box = searchBoxFor(view);
    if (!box) return true;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const raw = await source.itemsInBox(
        { ...box, limit: DOT_LIMIT },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || !enabled) return true;
      const list = raw.map(normalizeItem).filter(Boolean);
      items.clear();
      for (const pose of list) items.set(pose.id, pose);
      drawDots(list);
      count = list.length;
      hint = list.length ? null : NO_COVERAGE_HINT;
      lastError = null;
      lastUpdate = Date.now();
      return true;
    } catch (error) {
      if (controller.signal.aborted) return true;
      lastError = error?.retryAfterSec
        ? RATE_LIMITED_MESSAGE
        : error?.message || 'Panoramax unavailable';
      console.warn('[Data:StreetPhotos] coverage failed:', lastError);
      // Keep the layer on (the chip shows the error); the next move retries.
      return true;
    } finally {
      if (request === controller) request = null;
    }
  }

  function scheduleRefresh() {
    if (!enabled) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => void refresh(), MOVE_DEBOUNCE_MS);
  }

  async function openPicture(id) {
    if (!id) return false;
    selectedId = id;
    styleDots();
    let pose = items.get(id) || null;
    try {
      if (!pose || (!pose.prevId && !pose.nextId)) {
        const item = await source.getItem(id);
        const full = normalizeItem(item);
        if (full) pose = full;
      }
    } catch (error) {
      if (!pose) {
        photoViewer?.showError(error?.message || 'Panoramax unavailable');
        return false;
      }
    }
    if (selectedId !== id) return false;
    if (!pose) {
      photoViewer?.showError('This Panoramax photo is no longer available');
      return false;
    }
    items.set(pose.id, pose);
    photoViewer?.show(pose);
    return true;
  }

  const layer = {
    id: STREET_PHOTOS_LAYER_ID,
    name: 'Street Photos (Panoramax)',
    icon: '📷',
    source: 'Panoramax (api.panoramax.xyz)',
    updateInterval: 10 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Street Photos layer is already initialized');
      viewer = nextViewer;
      points = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
      points.show = false;
      photoViewer = createViewer({
        onStep: (id) => void openPicture(id),
        onClose: () => {
          selectedId = null;
          styleDots();
        },
      });
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click) => {
        if (!enabled) return;
        const id = pictureIdFromPick(viewer.scene.pick(click.position));
        if (id) void openPicture(id);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      removeMoveEnd = viewer.camera.moveEnd.addEventListener(scheduleRefresh);
    },

    enable() {
      enabled = true;
      if (points) points.show = true;
      scheduleRefresh();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      clearTimeout(debounce);
      if (points) {
        points.removeAll();
        points.show = false;
      }
      photoViewer?.close();
      count = 0;
      hint = null;
    },

    update() {
      return refresh();
    },

    /** Open a picture by id (tests, voice, links). */
    openPicture,

    destroy(nextViewer = viewer) {
      layer.disable();
      handler?.destroy();
      handler = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      if (points) nextViewer?.scene?.primitives?.remove(points);
      points = null;
      photoViewer?.destroy();
      photoViewer = null;
      viewer = null;
    },

    getStats() {
      return { count, lastUpdate, lastError: lastError || null, enabled, hint };
    },
  };
  return layer;
}
