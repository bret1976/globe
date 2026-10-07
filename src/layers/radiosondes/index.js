/**
 * Live weather balloons (radiosondes) — each sonde drawn at its real
 * altitude with a faint tether down to the ground, colored by flight phase
 * (ascending / descending after burst / landed). Weather group toggle.
 */
import * as Cesium from 'cesium';
import { radiosondeColorCss } from './parse.js';

export const RADIOSONDES_LAYER_ID = 'radiosondes';
export const RADIOSONDES_OVERLAY_SOURCE_ID = 'radiosondes';
export const RADIOSONDES_OVERLAY_COHORT_LIMIT = 24;
export const RADIOSONDES_OVERLAY_COLLISION_CAPACITY = 16;

function colorFor(phase) {
  return Cesium.Color.fromCssColorString(radiosondeColorCss(phase));
}

/** "RS41-SG · 23.4 km ↑ 5.2 m/s · -48.1 °C" */
export function formatRadiosondeLabel(row) {
  const bits = [row.type || 'Radiosonde'];
  const km = Number(row.altM) / 1000;
  let alt = Number.isFinite(km) ? `${km.toFixed(1)} km` : '';
  if (Number.isFinite(row.velV) && row.velV !== null) {
    const arrow = row.velV > 1 ? '↑' : row.velV < -1 ? '↓' : '·';
    alt += ` ${arrow} ${Math.abs(row.velV).toFixed(1)} m/s`;
  }
  if (alt) bits.push(alt.trim());
  if (Number.isFinite(row.tempC) && row.tempC !== null) bits.push(`${row.tempC} °C`);
  return bits.join(' · ');
}

function createOverlayEntry(row, position) {
  return {
    id: String(row.stableId),
    position,
    variant: 'label',
    title: formatRadiosondeLabel(row),
    accent: radiosondeColorCss(row.phase),
    priority: 1000 + Math.min(50_000, Math.max(0, Number(row.altM) || 0)) / 10,
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
  return [...entries]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, RADIOSONDES_OVERLAY_COHORT_LIMIT);
}

/** Build the live radiosondes globe layer. */
export function createRadiosondesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Radiosondes requires a snapshot source');
  if (!overlayHost) throw new TypeError('Radiosondes requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;

  const layer = {
    id: RADIOSONDES_LAYER_ID,
    name: 'Weather Balloons (SondeHub)',
    icon: '🎈',
    source: 'SondeHub radiosonde network',
    updateInterval: 2 * 60_000,

    init(nextViewer) {
      if (viewer) throw new Error('Radiosondes layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(RADIOSONDES_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(RADIOSONDES_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(RADIOSONDES_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(RADIOSONDES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RADIOSONDES_OVERLAY_SOURCE_ID, false);
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
          // Landed and lost sondes sit on the ground at their last fix; only
          // balloons still being heard are drawn at altitude.
          const airborne = row.phase !== 'landed' && row.phase !== 'lost';
          const altM = airborne ? Math.max(0, Number(row.altM) || 0) : 0;
          const color = colorFor(row.phase);
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, altM);
          const ground = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 0);
          nextEntities.push(
            new Cesium.Entity({
              id: `radiosonde:${row.stableId}`,
              position,
              point: {
                pixelSize: airborne ? 8 : 5,
                color: color.withAlpha(airborne ? 0.95 : 0.6),
                heightReference: airborne
                  ? Cesium.HeightReference.NONE
                  : Cesium.HeightReference.CLAMP_TO_GROUND,
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 1,
              },
              polyline:
                altM > 500
                  ? {
                      positions: [ground, position],
                      width: 1,
                      arcType: Cesium.ArcType.NONE,
                      material: color.withAlpha(0.35),
                    }
                  : undefined,
              properties: {
                serial: row.serial,
                type: row.type,
                manufacturer: row.manufacturer,
                altM: row.altM,
                velV: row.velV,
                velH: row.velH,
                heading: row.heading,
                tempC: row.tempC,
                humidity: row.humidity,
                frequencyMHz: row.frequencyMHz,
                phase: row.phase,
                lastFixAltM: row.altM,
                ageS: row.ageS,
                observedAt: row.observedAt,
              },
            }),
          );
          if (airborne) overlayEntries.push(createOverlayEntry(row, position));
        }

        dataSource.entities.removeAll();
        for (const entity of nextEntities) dataSource.entities.add(entity);
        if (enabled) {
          overlayHost.setEntries(
            RADIOSONDES_OVERLAY_SOURCE_ID,
            selectOverlayCohort(overlayEntries),
            {
              cohortLimit: RADIOSONDES_OVERLAY_COHORT_LIMIT,
              collisionCapacity: RADIOSONDES_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        count = nextEntities.length;
        lastUpdate = Date.now();
        lastError = null;
        console.log(`[Data:Radiosondes] Updated: ${count} balloons`);
        return true;
      } catch (error) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        console.warn('[Data:Radiosondes] Fetch error:', error);
        lastError = error?.message || 'Radiosonde source unavailable';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(nextViewer = viewer) {
      request?.abort();
      request = null;
      viewer = null;
      enabled = false;
      overlayHost.clearSource(RADIOSONDES_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RADIOSONDES_OVERLAY_SOURCE_ID, false);
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

export { createRadiosondesSource } from './source.js';
export {
  normalizeRadiosondes,
  parseRadiosonde,
  radiosondePhase,
  radiosondeColorCss,
  RADIOSONDES_URL,
} from './parse.js';
