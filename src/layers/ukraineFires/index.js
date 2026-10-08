/**
 * Ukraine War Fires (FIRMS) — every NASA FIRMS VIIRS NOAA-20 fire detection
 * inside Ukraine's internationally recognised borders (incl. Crimea) since
 * 1 Jan 2022, colored by age so the front line reads in waves. Industrial
 * heat (FIRMS static sources) is excluded. Satellites see heat, not causes:
 * shelling, field burning and wildfires all register. Events group toggle.
 * Inspired by the 2026-10-07 @bilawal.ai reel (4.5 years of the war through
 * satellite fire detections).
 */
import * as Cesium from 'cesium';
import {
  UKRAINE_FIRE_BANDS,
  UKRAINE_FIRES_WINDOWS,
  bandForAge,
  coverageLabel,
  decodeUkraineFires,
  summarizeBands,
} from './parse.js';

export const UKRAINE_FIRES_LAYER_ID = 'ukraine-fires';
const PARTIAL_RETRY_MS = 60_000;
const MAX_PARTIAL_RETRIES = 30;

/** Build the Ukraine war fires globe layer. */
export function createUkraineFiresLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ukraine fires requires a snapshot source');

  let viewer = null;
  let points = null;
  let decoded = null;
  let request = null;
  let enabled = false;
  let loading = false;
  let lastUpdate = null;
  let lastError = null;
  let payloadMeta = null;
  let windowId = 'all';
  let shown = 0;
  let bandCounts = UKRAINE_FIRE_BANDS.map(() => 0);
  let rowListener = null;
  let retryTimer = null;
  let partialRetries = 0;
  const colors = UKRAINE_FIRE_BANDS.map((band) =>
    Cesium.Color.fromCssColorString(band.color).withAlpha(band.alpha),
  );

  const notifyRow = () => {
    try {
      rowListener?.();
    } catch {
      /* panel listener is best-effort */
    }
  };

  function currentWindow() {
    return (
      UKRAINE_FIRES_WINDOWS.find((w) => w.id === windowId) ||
      UKRAINE_FIRES_WINDOWS[0]
    );
  }

  function applyWindow() {
    if (!points || !decoded) return;
    const win = currentWindow().days;
    const n = Math.min(points.length, decoded.count);
    for (let i = 0; i < n; i++) {
      points.get(i).show = decoded.today - decoded.day[i] <= win;
    }
    const summary = summarizeBands(decoded, win);
    shown = summary.shown;
    bandCounts = summary.counts;
    viewer?.scene?.requestRender?.();
  }

  function rebuild(next) {
    if (!viewer) return;
    if (points) {
      viewer.scene.primitives.remove(points);
      points = null;
    }
    const collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    const scale = new Cesium.NearFarScalar(2.0e5, 1.6, 4.0e6, 0.6);
    for (let i = 0; i < next.count; i++) {
      const band = bandForAge(next.today - next.day[i]);
      const spec = UKRAINE_FIRE_BANDS[band];
      collection.add({
        position: Cesium.Cartesian3.fromDegrees(next.lon[i], next.lat[i], 60),
        color: colors[band],
        pixelSize: spec.size,
        scaleByDistance: scale,
        disableDepthTestDistance: 0,
      });
    }
    collection.show = enabled;
    viewer.scene.primitives.add(collection);
    points = collection;
    decoded = next;
    applyWindow();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (!enabled || partialRetries >= MAX_PARTIAL_RETRIES) return;
    partialRetries++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void layer.update();
    }, PARTIAL_RETRY_MS);
  }

  const layer = {
    id: UKRAINE_FIRES_LAYER_ID,
    name: 'Ukraine War Fires (FIRMS)',
    icon: '🔥',
    source: 'NASA FIRMS VIIRS',
    updateInterval: 30 * 60_000,
    firstUpdateDeadlineMs: 20_000,

    init(nextViewer) {
      if (viewer) throw new Error('Ukraine fires layer is already initialized');
      viewer = nextViewer;
    },

    enable() {
      enabled = true;
      if (points) points.show = true;
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      loading = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (points) points.show = false;
    },

    async update() {
      if (!enabled || !viewer) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      loading = !decoded;
      notifyRow();
      try {
        const payload = await source.getSnapshot({ signal: controller.signal });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        const next = decodeUkraineFires(payload);
        payloadMeta = { ...payload, points: undefined };
        if (
          !decoded ||
          next.count !== decoded.count ||
          next.today !== decoded.today
        )
          rebuild(next);
        lastUpdate = Date.now();
        lastError = null;
        if (payload.complete === false) scheduleRetry();
        else partialRetries = 0;
        console.log(
          `[Data:UkraineFires] ${next.count} detections (${coverageLabel(payload)})`,
        );
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn(
          '[Data:UkraineFires] Fetch error:',
          error?.message || error,
        );
        lastError = error?.message || 'Ukraine fires source unavailable';
        return false;
      } finally {
        if (request === controller) {
          request = null;
          loading = false;
          notifyRow();
        }
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (points) nextViewer?.scene?.primitives?.remove(points);
      points = null;
      decoded = null;
      viewer = null;
      enabled = false;
      lastUpdate = null;
      lastError = null;
      payloadMeta = null;
    },

    getRowControls() {
      return {
        chips: UKRAINE_FIRES_WINDOWS.map((win) => ({
          id: `window-${win.id}`,
          label: win.label,
          title: win.title,
          active: win.id === windowId,
          disabled: !decoded,
          onClick: () => {
            windowId = win.id;
            applyWindow();
            notifyRow();
          },
        })),
        legend: UKRAINE_FIRE_BANDS.map((band, index) => ({
          label: band.label,
          color: band.color,
          count: bandCounts[index] || 0,
          ...(index === 0
            ? {
                blurb:
                  'NASA FIRMS VIIRS NOAA-20 (375 m) detections inside Ukraine incl. Crimea. Industrial heat excluded. Satellites see heat, not causes.',
              }
            : {}),
        })),
      };
    },

    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const partial =
        Boolean(payloadMeta?.backfill?.running) ||
        payloadMeta?.complete === false;
      return {
        count: decoded ? shown : 0,
        lastUpdate,
        lastError,
        loading,
        enabled,
        partial,
        ...(payloadMeta ? { loadingLabel: coverageLabel(payloadMeta) } : {}),
        totalDetections: decoded?.count || 0,
        window: windowId,
      };
    },
  };

  return layer;
}

export { createUkraineFiresSource } from './source.js';
