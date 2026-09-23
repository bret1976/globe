/**
 * Wind overlay — coarse Open-Meteo GFS 10 m wind as colored, oriented
 * arrows on the globe. Visible at Earth-to-regional scale; parks when the
 * camera is street-level so it does not wash out city views.
 */
import * as Cesium from 'cesium';

export const WIND_LAYER_ID = 'wind';
export const HIDE_BELOW_M = 180_000;
export const WIND_ZOOM_OUT_MESSAGE =
  'Zoom out above 180 km to see global wind';

function speedColor(speedKmh) {
  if (speedKmh < 20) return Cesium.Color.fromCssColorString('#7ec8ff');
  if (speedKmh < 40) return Cesium.Color.fromCssColorString('#ffe066');
  if (speedKmh < 70) return Cesium.Color.fromCssColorString('#ff9f43');
  return Cesium.Color.fromCssColorString('#ff4d4d');
}

/** Create the wind layer. */
export function createWindLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Wind layer requires a snapshot source');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let error = null;
  let samples = [];

  function rebuild() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    const height =
      viewer?.camera?.positionCartographic?.height ?? Number.POSITIVE_INFINITY;
    if (height < HIDE_BELOW_M) {
      count = samples.length;
      return;
    }
    for (const sample of samples) {
      const position = Cesium.Cartesian3.fromDegrees(sample.lon, sample.lat);
      const heading = Cesium.Math.toRadians(sample.direction);
      dataSource.entities.add({
        id: `wind:${sample.lon}:${sample.lat}`,
        position,
        ellipse: {
          semiMajorAxis: 90_000,
          semiMinorAxis: 28_000,
          rotation: -heading,
          material: speedColor(sample.speed).withAlpha(0.55),
          outline: true,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.35),
          height: 0,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
    count = samples.length;
  }

  return {
    id: WIND_LAYER_ID,
    name: 'Wind',
    icon: '🌬',
    source: 'Open-Meteo GFS · 10 m',
    updateInterval: 30 * 60_000,
    init(nextViewer) {
      if (viewer) throw new Error('Wind layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('wind');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      viewer.camera.moveEnd.addEventListener(rebuild);
    },
    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },
    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
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
        samples = payload.samples || [];
        lastUpdate = Date.now();
        error = null;
        rebuild();
        return true;
      } catch (err) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        error = err?.message || 'Wind source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },
    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      enabled = false;
      samples = [];
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      viewer = null;
    },
    getStats() {
      const height =
        viewer?.camera?.positionCartographic?.height ??
        Number.POSITIVE_INFINITY;
      const hidden = Boolean(enabled && !error && height < HIDE_BELOW_M);
      return {
        count,
        lastUpdate,
        error,
        status: hidden ? 'zoom-out' : error ? 'error' : undefined,
        statusMessage: hidden ? WIND_ZOOM_OUT_MESSAGE : undefined,
      };
    },
  };
}

export { createWindSource } from './source.js';
