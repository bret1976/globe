/**
 * Cyclone context — NHC advisories plus EONET severe storms, drawn as
 * labeled positions and tracks on the globe. Selection highlights one
 * storm and exposes it on the data-panel row.
 */
import * as Cesium from 'cesium';

export const CYCLONE_LAYER_ID = 'weather-cyclones';

function classificationColor(classification, windKt) {
  const wind = Number(windKt);
  if (Number.isFinite(wind) && wind >= 64)
    return Cesium.Color.fromCssColorString('#ff4d6d');
  if (String(classification || '').toUpperCase().startsWith('HU'))
    return Cesium.Color.fromCssColorString('#ff4d6d');
  if (Number.isFinite(wind) && wind >= 34)
    return Cesium.Color.fromCssColorString('#ffb703');
  return Cesium.Color.fromCssColorString('#7ec8ff');
}

function stormLabel(storm) {
  const wind =
    Number.isFinite(storm.windKt) && storm.windKt > 0
      ? ` · ${Math.round(storm.windKt)} kt`
      : '';
  return `${storm.name}${wind}`;
}

/** Create the cyclone layer. */
export function createCyclonesLayer({ source, cesium = Cesium } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Cyclones require a snapshot source');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let storms = [];
  let selectedId = null;
  let lastUpdate = null;
  let error = null;
  let rowListener = null;

  function notifyRow() {
    rowListener?.();
  }

  function rebuild() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    for (const storm of storms) {
      const color = classificationColor(storm.classification, storm.windKt);
      const selected = storm.id === selectedId;
      const position = cesium.Cartesian3.fromDegrees(storm.lon, storm.lat);
      dataSource.entities.add({
        id: storm.id,
        name: storm.name,
        position,
        point: {
          pixelSize: selected ? 16 : 11,
          color,
          outlineColor: cesium.Color.WHITE,
          outlineWidth: selected ? 3 : 1,
          heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: stormLabel(storm),
          font: '12px JetBrains Mono, monospace',
          fillColor: cesium.Color.WHITE,
          outlineColor: cesium.Color.BLACK,
          outlineWidth: 3,
          style: cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: cesium.Color.BLACK.withAlpha(selected ? 0.65 : 0.4),
        },
      });
      const track = Array.isArray(storm.track) ? storm.track : [];
      if (track.length >= 2) {
        dataSource.entities.add({
          id: `${storm.id}:track`,
          polyline: {
            positions: track.map((point) =>
              cesium.Cartesian3.fromDegrees(point.lon, point.lat),
            ),
            width: selected ? 3 : 1.5,
            material: color.withAlpha(0.85),
            clampToGround: true,
          },
        });
      }
    }
  }

  return {
    id: CYCLONE_LAYER_ID,
    name: 'Cyclones',
    icon: '🌀',
    source: 'NOAA NHC + NASA EONET',
    updateInterval: 5 * 60_000,
    init(nextViewer) {
      if (viewer) throw new Error('Cyclone layer is already initialized');
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource('weather-cyclones');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
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
        storms = Array.isArray(payload?.storms) ? payload.storms : [];
        if (selectedId && !storms.some((storm) => storm.id === selectedId))
          selectedId = null;
        lastUpdate = Date.now();
        error = null;
        rebuild();
        notifyRow();
        return true;
      } catch (err) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        error = err?.message || 'Cyclone source unavailable';
        notifyRow();
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },
    setParams(params) {
      if (!params || typeof params !== 'object') return false;
      if (!Object.hasOwn(params, 'selected')) return false;
      const next =
        typeof params.selected === 'string' && params.selected
          ? params.selected
          : null;
      if (next === selectedId) return false;
      selectedId = next;
      rebuild();
      notifyRow();
      return true;
    },
    getParams() {
      return { selected: selectedId };
    },
    getRowControls() {
      return {
        chips: storms.slice(0, 8).map((storm) => ({
          id: storm.id,
          label: storm.name,
          active: storm.id === selectedId,
          title: [storm.basin, storm.source].filter(Boolean).join(' · '),
          params: { selected: storm.id },
        })),
      };
    },
    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },
    getFocusPositions() {
      return storms.map((storm) => ({
        id: storm.id,
        lat: storm.lat,
        lon: storm.lon,
      }));
    },
    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      enabled = false;
      storms = [];
      selectedId = null;
      rowListener = null;
      if (dataSource) {
        nextViewer?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      viewer = null;
    },
    getStats() {
      return { count: storms.length, lastUpdate, error };
    },
  };
}

export { createCycloneSource } from './source.js';
