/**
 * FlyDubai FZ1073 (30 Sep 2026) reconstruction layer — altitude-aware FR24 track.
 * GodsEye original code. Inspiration only: Bilawal Sidhu Instagram FPV short.
 */
import * as Cesium from 'cesium';
import { FZ1073_CREDIT, registerDynamicCredit } from './dataCredits.js';
import {
  FZ1073_AIRCRAFT,
  FZ1073_DATE_UTC,
  FZ1073_FLIGHT,
  FZ1073_FT_TO_M,
  FZ1073_LAYER_ID,
  FZ1073_PEAK_VS_FPM,
  FZ1073_TRACK,
  fz1073DivePoints,
} from './fz1073Track.js';

const TRACK_COLOR = Cesium.Color.fromCssColorString('#7fd3ff').withAlpha(0.85);
const DIVE_COLOR = Cesium.Color.fromCssColorString('#ff6b4a').withAlpha(0.95);
const MARKER_COLOR = Cesium.Color.fromCssColorString('#ffd166');

function positionsFrom(points) {
  const out = [];
  for (const p of points) {
    out.push(p.lon, p.lat, Math.max(0, p.alt_ft) * FZ1073_FT_TO_M);
  }
  return Cesium.Cartesian3.fromDegreesArrayHeights(out);
}

/** Build the static FZ1073 reconstruction globe layer. */
export function createFz1073Layer() {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let creditRegistered = false;

  function ensureEntities() {
    if (!dataSource || dataSource.entities.values.length) return;
    const dive = fz1073DivePoints();
    const diveTs = new Set(dive.map((p) => p.t));
    const cruise = FZ1073_TRACK.filter((p) => !diveTs.has(p.t));
    const peak =
      dive.find((p) => p.vs_fpm === FZ1073_PEAK_VS_FPM) ||
      dive.reduce(
        (best, p) => (!best || p.vs_fpm < best.vs_fpm ? p : best),
        null,
      );

    if (cruise.length >= 2) {
      dataSource.entities.add({
        id: 'fz1073:track',
        name: `${FZ1073_FLIGHT} track`,
        polyline: {
          positions: positionsFrom(cruise),
          width: 2.5,
          material: TRACK_COLOR,
          clampToGround: false,
          arcType: Cesium.ArcType.NONE,
        },
      });
    }

    if (dive.length >= 2) {
      dataSource.entities.add({
        id: 'fz1073:dive',
        name: `${FZ1073_FLIGHT} dive`,
        polyline: {
          positions: positionsFrom(dive),
          width: 4.5,
          material: DIVE_COLOR,
          clampToGround: false,
          arcType: Cesium.ArcType.NONE,
        },
      });
    }

    if (peak) {
      dataSource.entities.add({
        id: 'fz1073:peak',
        name: `${FZ1073_FLIGHT} peak descent`,
        position: Cesium.Cartesian3.fromDegrees(
          peak.lon,
          peak.lat,
          peak.alt_ft * FZ1073_FT_TO_M,
        ),
        point: {
          pixelSize: 10,
          color: MARKER_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${FZ1073_FLIGHT} · peak ${FZ1073_PEAK_VS_FPM} fpm`,
          font: '11px JetBrains Mono, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#041018').withAlpha(
            0.72,
          ),
        },
      });
    }

    const last = FZ1073_TRACK[FZ1073_TRACK.length - 1];
    if (last) {
      dataSource.entities.add({
        id: 'fz1073:tuu',
        name: 'Divert TUU',
        position: Cesium.Cartesian3.fromDegrees(
          last.lon,
          last.lat,
          Math.max(200, last.alt_ft * FZ1073_FT_TO_M),
        ),
        point: {
          pixelSize: 8,
          color: TRACK_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${FZ1073_FLIGHT} divert · TUU`,
          font: '11px JetBrains Mono, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -12),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#041018').withAlpha(
            0.72,
          ),
        },
      });
    }
  }

  const layer = {
    id: FZ1073_LAYER_ID,
    name: 'FlyDubai FZ1073',
    icon: '✈',
    source: 'Flightradar24 ADS-B (curated)',
    updateInterval: 0,

    init(nextViewer) {
      if (viewer) throw new Error('FZ1073 layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(FZ1073_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      ensureEntities();
      if (dataSource) dataSource.show = true;
      if (viewer && !creditRegistered) {
        creditRegistered = registerDynamicCredit(viewer, FZ1073_CREDIT);
      }
      viewer?.scene?.requestRender?.();
    },

    disable() {
      enabled = false;
      if (dataSource) dataSource.show = false;
      viewer?.scene?.requestRender?.();
    },

    async update() {
      return enabled;
    },

    destroy() {
      if (dataSource && viewer) {
        viewer.dataSources.remove(dataSource, true);
      }
      dataSource = null;
      viewer = null;
      enabled = false;
    },

    getStats() {
      return {
        count: FZ1073_TRACK.length,
        flight: FZ1073_FLIGHT,
        aircraft: FZ1073_AIRCRAFT,
        dateUtc: FZ1073_DATE_UTC,
        peakVsFpm: FZ1073_PEAK_VS_FPM,
        lastUpdate: enabled ? FZ1073_DATE_UTC : null,
        lastError: null,
      };
    },
  };

  return layer;
}

export { FZ1073_LAYER_ID };
