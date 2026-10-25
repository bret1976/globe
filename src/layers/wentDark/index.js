import * as Cesium from 'cesium';
import { mergeWentDark, wentDarkInfo, wentDarkItemText } from './model.js';
import { lastSeenText } from '../../data/wentDark.js';
export { createWentDarkSource } from './source.js';
export * from './model.js';

const GHOST_COLOR = Cesium.Color.fromCssColorString('#ffb347');
const LIST_LIMIT = 40;
const RENDER_LIMIT = 600;

/**
 * "Went dark": ghost markers at the last-known position of ships and aircraft
 * that stopped reporting. Everything is an inference held in memory.
 */
export function createWentDarkLayer({ source, now = () => Date.now() } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Went-dark layer requires a snapshot source');
  let _viewer = null;
  let _ds = null;
  let _enabled = false;
  let _snapshot = null;
  let _items = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _rowListener = null;
  let _tick = null;
  const notifyRow = () => {
    try {
      _rowListener?.();
    } catch {
      /* best-effort */
    }
  };

  function flyTo(item) {
    if (!_viewer) return;
    _viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        item.lon,
        item.lat,
        item.kind === 'ship' ? 60_000 : 180_000,
      ),
      duration: 1.6,
    });
  }

  function render() {
    if (!_ds) return;
    const keep = new Set();
    for (const item of _items.length ? mergeWentDark(_snapshot, { limit: RENDER_LIMIT }) : []) {
      const id = `went-dark:${item.kind}:${item.id}`;
      keep.add(id);
      const props = {
        provenance: 'inferred',
        provider: item.provider,
        fetchedAt: _lastUpdate,
        kind: item.kind,
        id: item.id,
        label: item.label,
        lastSeenAt: new Date(item.lastAtLocal).toISOString(),
        typicalIntervalSec: Math.round(item.typicalIntervalMs / 1000),
        thresholdSec: Math.round(item.thresholdMs / 1000),
        reports: item.reports,
        peersStillReporting: item.peers,
        speed: item.speed,
        heading: item.heading,
        altitudeM: item.altitudeM,
      };
      let entity = _ds.entities.getById(id);
      const position = Cesium.Cartesian3.fromDegrees(item.lon, item.lat, item.kind === 'ship' ? 0 : item.altitudeM || 0);
      if (!entity) {
        const lastAt = item.lastAtLocal;
        entity = _ds.entities.add({
          id,
          name: `${item.label} (went dark)`,
          position,
          point: {
            pixelSize: 11,
            color: GHOST_COLOR.withAlpha(0.15),
            outlineColor: GHOST_COLOR.withAlpha(0.9),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: new Cesium.CallbackProperty(
              () => `${item.label} · ${lastSeenText(now() - entity.__gevLastAt)}`,
              false,
            ),
            font: '11px "JetBrains Mono", monospace',
            fillColor: GHOST_COLOR,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(10, -10),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4_000_000),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        entity.__gevLastAt = lastAt;
        entity.__gevLayerId = 'went-dark';
      } else {
        entity.position = position;
        entity.__gevLastAt = item.lastAtLocal;
      }
      entity.properties = new Cesium.PropertyBag(props);
      const trail = (item.trail || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (trail.length >= 2) {
        entity.polyline = {
          positions: trail.map(([lon, lat]) =>
            Cesium.Cartesian3.fromDegrees(lon, lat, item.kind === 'ship' ? 0 : item.altitudeM || 0),
          ),
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: GHOST_COLOR.withAlpha(0.7),
            dashLength: 12,
          }),
          clampToGround: item.kind === 'ship',
        };
      } else {
        entity.polyline = undefined;
      }
    }
    for (const entity of [..._ds.entities.values]) {
      if (!keep.has(entity.id)) _ds.entities.remove(entity);
    }
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'went-dark',
    name: 'Went Dark',
    icon: '◌',
    source: 'AISStream / OpenSky / adsb.lol',
    updateInterval: 30000,

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    init(viewer) {
      _viewer = viewer;
      _ds = new Cesium.CustomDataSource('went-dark');
      _ds.show = false;
      viewer.dataSources.add(_ds);
    },

    enable() {
      _enabled = true;
      if (_ds) _ds.show = true;
      clearInterval(_tick);
      // "Last seen X ago" in the row list ages between refreshes.
      _tick = setInterval(notifyRow, 15_000);
    },

    disable() {
      _enabled = false;
      clearInterval(_tick);
      _tick = null;
      if (_ds) _ds.show = false;
    },

    async update(_viewer2, { signal } = {}) {
      if (!_enabled) return;
      try {
        _snapshot = await source.getSnapshot({}, { signal });
        _items = mergeWentDark(_snapshot, { limit: LIST_LIMIT });
        _lastUpdate = now();
        _lastError = null;
        render();
      } catch (error) {
        if (signal?.aborted) return;
        _lastError = error?.message || 'Went-dark unavailable';
      }
      notifyRow();
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_ds && viewer) viewer.dataSources.remove(_ds, true);
      _ds = null;
      _viewer = null;
      _snapshot = null;
      _items = [];
      _rowListener = null;
    },

    getRowControls() {
      const localNow = now();
      return {
        chips: [],
        list: {
          ariaLabel: 'Went dark, most recent first',
          items: _items.length
            ? _items.map((item) => ({
                id: `${item.kind}:${item.id}`,
                lead: item.kind === 'ship' ? 'SHIP' : 'AIR',
                text: wentDarkItemText(item, localNow),
                onClick: () => flyTo(item),
              }))
            : [],
        },
        info: _snapshot
          ? wentDarkInfo(_snapshot)
          : _lastError || 'Waiting for the first check…',
        infoTitle:
          'Inferred, in memory only. A target is listed when it had been reporting steadily, was moving, then went silent far longer than its usual interval while nearby targets kept reporting. Coverage holes and stale or partial feeds are never flagged. A silence is not proof a transponder was switched off. Aircraft need the Flights layer on (worldwide feed); ships come from the server AIS stream.',
        legend: [
          { label: 'Last-known position (ghost) + recent trail', color: '#ffb347', count: _items.length },
        ],
      };
    },

    getStats() {
      const ships = _snapshot?.ships;
      const air = _snapshot?.aircraft;
      return {
        count: (ships?.flagged?.length || 0) + (air?.flagged?.length || 0),
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: Boolean(
          _snapshot && ships?.status !== 'ok' && air?.status !== 'ok',
        ),
        fallback: false,
      };
    },
  };
  return layer;
}
