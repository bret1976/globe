import * as Cesium from 'cesium';
import {
  resolveOperatorLocation,
  primeOperatorLocation,
  viewerCameraLatLon,
  nearestByHaversine,
  isFiniteLatLon,
  readCachedOperatorLocation,
} from '../data/operatorLocation.js';
import { abortShortsPack } from '../data/shortsPack.js';
import {
  layerFocusHeightM,
  layerFocusPitchDeg,
  planEnabledLayerFocus,
  pickImmediateOperatorFocus,
  collectLayerFocusObjects,
  shouldSnapOperatorBeforeEnable,
  layerVenueFallback,
  pickVesselFocusAnchor,
  layerLiveDestination,
  pickLayerFocusAnchor,
  waitForLayerFocusObjects,
} from './layerFocusPlan.js';

export {
  LAYER_FOCUS_HEIGHT_M,
  SPACE_VIEW_HEIGHT_M,
  MAX_CCTV_NEAREST_KM,
  LAYER_LIVE_DESTINATIONS,
  layerFocusHeightM,
  layerFocusPitchDeg,
  isUsableOperatorCameraHeight,
  isNearbyOperatorFocus,
  pickImmediateOperatorFocus,
  shouldFocusUserEnabledLayer,
  shouldSnapOperatorBeforeEnable,
  planEnabledLayerFocus,
  collectLayerFocusObjects,
  layerVenueFallback,
  layerLiveDestination,
  pickLayerFocusAnchor,
  pickVesselFocusAnchor,
  waitForLayerFocusObjects,
} from './layerFocusPlan.js';

function cartographicLatLon(cartesian) {
  if (!cartesian) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  return isFiniteLatLon(lat, lon) ? { lat, lon } : null;
}

export function pickNearestDetectable(objects, lat, lon) {
  return nearestByHaversine(objects || [], lat, lon, (object) => {
    if (isFiniteLatLon(object?.lat, object?.lon)) {
      return { lat: object.lat, lon: object.lon };
    }
    if (isFiniteLatLon(object?.latitude, object?.longitude)) {
      return { lat: object.latitude, lon: object.longitude };
    }
    return cartographicLatLon(object?.position);
  })?.item;
}

function objectLatLon(object) {
  if (isFiniteLatLon(object?.lat, object?.lon)) {
    return { lat: object.lat, lon: object.lon };
  }
  if (isFiniteLatLon(object?.latitude, object?.longitude)) {
    return { lat: object.latitude, lon: object.longitude };
  }
  return null;
}

function flyToLatLon(
  viewer,
  lat,
  lon,
  heightM,
  durationSec = 1.8,
  pitchDeg = -42,
) {
  if (!viewer?.camera || !isFiniteLatLon(lat, lon)) return false;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
    duration: Math.max(0.2, durationSec),
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
  return true;
}

function flyToCartesian(viewer, position, heightM, durationSec = 1.6) {
  if (!viewer?.camera || !position) return false;
  const range = Math.max(400, (heightM || 8_000) * 0.35);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(position, 80), {
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), range),
    duration: Math.max(0.2, durationSec),
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
  return true;
}

export function resolveViewerOperatorFallback(viewer) {
  return viewerCameraLatLon(viewer, (radians) =>
    Cesium.Math.toDegrees(radians),
  );
}

export function createOperatorLocationResolver(viewer) {
  return () =>
    resolveOperatorLocation({
      fallback: resolveViewerOperatorFallback(viewer),
    });
}

function releaseStaleTracking(viewer) {
  if (viewer?.trackedEntity) viewer.trackedEntity = undefined;
}

export function snapViewerToLayerFocus(
  viewer,
  lat,
  lon,
  heightM,
  pitchDeg = -42,
) {
  if (!viewer?.camera || !isFiniteLatLon(lat, lon)) return false;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  });
  return true;
}

function collectFocusObjects(module) {
  let detectable = [];
  try {
    detectable =
      typeof module?.getDetectableObjects === 'function'
        ? module.getDetectableObjects({ maxCount: 2500 }) || []
        : [];
  } catch {
    detectable = [];
  }
  let positions = [];
  try {
    positions =
      typeof module?.getAllPositions === 'function'
        ? module.getAllPositions(12_000) || []
        : [];
  } catch {
    positions = [];
  }
  return collectLayerFocusObjects({ detectable, positions });
}

/**
 * Snap to the layer's live destination BEFORE enable. Do not wait on GPS —
 * the permission dialog was leaving every Data Layer button stuck/disabled.
 */
export async function prepareEnabledLayerFocus({
  viewer,
  layerId,
} = {}) {
  if (!viewer?.camera) return { ok: false, reason: 'no-viewer' };
  if (
    typeof document !== 'undefined' &&
    document.body?.classList.contains('cockpit-mode')
  ) {
    return { ok: false, reason: 'cockpit' };
  }
  abortShortsPack();
  releaseStaleTracking(viewer);

  const camera = resolveViewerOperatorFallback(viewer);
  primeOperatorLocation({ fallback: camera });
  const cached = readCachedOperatorLocation();
  const immediate = pickImmediateOperatorFocus({
    cached,
    camera,
    cameraHeightM: viewer.camera.positionCartographic?.height,
  });
  if (!shouldSnapOperatorBeforeEnable(layerId)) {
    const dest = layerLiveDestination(layerId);
    if (dest) {
      snapViewerToLayerFocus(
        viewer,
        dest.lat,
        dest.lon,
        dest.heightM,
        dest.pitchDeg || layerFocusPitchDeg(layerId),
      );
      return { ok: true, location: dest, mode: 'venue' };
    }
    return { ok: true, location: cached || immediate || camera };
  }

  const anchor = pickLayerFocusAnchor({
    layerId,
    location: cached || immediate,
  });
  if (anchor) {
    snapViewerToLayerFocus(
      viewer,
      anchor.lat,
      anchor.lon,
      anchor.heightM || layerFocusHeightM(layerId),
      anchor.pitchDeg || layerFocusPitchDeg(layerId),
    );
    return { ok: true, location: anchor, mode: anchor.mode };
  }
  return { ok: false, reason: 'no-location' };
}

export function focusCctvLiveDestination(viewer, module) {
  const dest = layerLiveDestination('cctv');
  if (!dest || !viewer?.camera) return { ok: false, reason: 'no-destination' };
  releaseStaleTracking(viewer);
  abortShortsPack();
  const nearest =
    typeof module?.nearestCameraToLatLon === 'function'
      ? module.nearestCameraToLatLon(dest.lat, dest.lon)
      : null;
  flyToLatLon(
    viewer,
    dest.lat,
    dest.lon,
    dest.heightM,
    1.8,
    dest.pitchDeg || layerFocusPitchDeg('cctv'),
  );
  if (nearest?.id) {
    module.focusNearest?.({
      focus: false,
      lat: dest.lat,
      lon: dest.lon,
    });
  }
  return { ok: true, mode: 'venue', id: nearest?.id || null, destination: dest };
}

/**
 * After a Data Layers row enable, fly to that layer's live data immediately.
 * Cache-only location — never await the geolocation prompt.
 */
export async function focusEnabledLayer({
  viewer,
  layerId,
  module,
} = {}) {
  if (!viewer?.camera) return { ok: false, reason: 'no-viewer' };
  if (
    typeof document !== 'undefined' &&
    document.body?.classList.contains('cockpit-mode')
  ) {
    return { ok: false, reason: 'cockpit' };
  }
  abortShortsPack();
  releaseStaleTracking(viewer);

  const cached = readCachedOperatorLocation();
  const camera = resolveViewerOperatorFallback(viewer);
  const location = pickImmediateOperatorFocus({
    cached,
    camera,
    cameraHeightM: viewer.camera.positionCartographic?.height,
  });

  let nearestCameraId = null;
  let nearestCameraDistKm = null;
  if (layerId === 'cctv' && typeof module?.nearestCameraToLatLon === 'function') {
    const probe = location || layerLiveDestination('cctv');
    const nearest = probe
      ? module.nearestCameraToLatLon(probe.lat, probe.lon)
      : null;
    nearestCameraId = nearest?.id || null;
    nearestCameraDistKm = nearest?.distKm ?? null;
  }

  const needsLiveObjects =
    layerId === 'flights' ||
    layerId === 'military' ||
    layerId === 'ais-live-vessels';
  // Live Vessels has no inland data. Fly to the ships venue first so the
  // click is never a 4–10s no-op while AIS is still downloading.
  if (layerId === 'ais-live-vessels') {
    const venue = layerLiveDestination(layerId);
    if (venue) {
      flyToLatLon(
        viewer,
        venue.lat,
        venue.lon,
        venue.heightM,
        1.4,
        venue.pitchDeg || layerFocusPitchDeg(layerId),
      );
    }
  }
  if (needsLiveObjects) {
    try {
      await module.update?.();
    } catch {
      /* layer chip already owns fetch errors */
    }
    await waitForLayerFocusObjects({
      collect: () => collectFocusObjects(module),
      timeoutMs: layerId === 'ais-live-vessels' ? 1_200 : 4_500,
    });
  }

  const objects = collectFocusObjects(module);
  const nearestObject = location
    ? pickNearestDetectable(objects, location.lat, location.lon)
    : pickNearestDetectable(
        objects,
        layerLiveDestination(layerId)?.lat,
        layerLiveDestination(layerId)?.lon,
      );

  const plan = planEnabledLayerFocus({
    layerId,
    location,
    nearestCameraId,
    nearestCameraDistKm,
    hasAlprFocus:
      layerId === 'alpr-cameras' && typeof module?.focusNearest === 'function',
    nearestObject,
  });

  if (plan.mode === 'cctv') {
    module.focusCamera?.(plan.id, 1.8);
    return { ok: true, mode: 'cctv', id: plan.id, location };
  }

  if (plan.mode === 'alpr') {
    const destLat = plan.lat ?? location?.lat;
    const destLon = plan.lon ?? location?.lon;
    flyToLatLon(
      viewer,
      destLat,
      destLon,
      plan.heightM,
      1.4,
      layerFocusPitchDeg(layerId),
    );
    try {
      await module.update?.();
    } catch {
      /* layer chip already owns fetch errors */
    }
    await waitForLayerFocusObjects({
      collect: () => collectFocusObjects(module),
    });
    module.focusNearest?.({ lat: destLat, lon: destLon });
    return { ok: true, mode: 'alpr', location: plan };
  }

  if (layerId === 'satellites') {
    const iss = module.findByQuery?.('25544') || module.findByQuery?.('ISS');
    if (iss && module.trackById?.(iss.noradId || 25544)) {
      return { ok: true, mode: 'iss', id: iss.noradId || 25544, location };
    }
  }

  if (
    layerId === 'rocket-launches' &&
    typeof module?.focusNearest === 'function'
  ) {
    const dest = layerLiveDestination(layerId) || location;
    const id = dest
      ? module.focusNearest({ lat: dest.lat, lon: dest.lon })
      : module.focusNearest();
    if (id) return { ok: true, mode: 'launch', id, location: dest };
  }

  if (
    layerId === 'ais-live-vessels' &&
    typeof module?.focusNearest === 'function'
  ) {
    const venue = layerVenueFallback(layerId);
    const anchor = pickVesselFocusAnchor(location, venue) || venue;
    if (anchor) {
      const currentId = module.getSelectedInfo?.()?.mmsi;
      const id = module.focusNearest({
        lat: anchor.lat,
        lon: anchor.lon,
        excludeId: currentId,
      });
      const selected = module.getSelectedInfo?.();
      if (
        selected &&
        isFiniteLatLon(selected.latitude, selected.longitude)
      ) {
        flyToLatLon(
          viewer,
          selected.latitude,
          selected.longitude,
          layerFocusHeightM(layerId),
          1.8,
          layerFocusPitchDeg(layerId),
        );
        return { ok: true, mode: 'vessel', id: selected.mmsi || id, location };
      }
    }
  }

  if (plan.mode === 'object') {
    if (nearestObject?.position) {
      flyToCartesian(viewer, nearestObject.position, plan.heightM);
      return { ok: true, mode: 'object', id: plan.id, location };
    }
    const coords = objectLatLon(nearestObject);
    if (coords) {
      flyToLatLon(
        viewer,
        coords.lat,
        coords.lon,
        plan.heightM,
        1.8,
        layerFocusPitchDeg(layerId),
      );
      return { ok: true, mode: 'object', id: plan.id, location };
    }
  }

  if (plan.mode === 'venue' || plan.mode === 'operator') {
    if (layerId === 'cctv') {
      return focusCctvLiveDestination(viewer, module);
    }
    flyToLatLon(
      viewer,
      plan.lat ?? location?.lat,
      plan.lon ?? location?.lon,
      plan.heightM || layerFocusHeightM(layerId),
      1.8,
      plan.pitchDeg || layerFocusPitchDeg(layerId),
    );
    return { ok: true, mode: plan.mode, location: plan };
  }

  const dest = layerLiveDestination(layerId);
  if (dest) {
    flyToLatLon(
      viewer,
      dest.lat,
      dest.lon,
      dest.heightM,
      1.8,
      dest.pitchDeg || layerFocusPitchDeg(layerId),
    );
    return { ok: true, mode: 'venue', location: dest };
  }
  return { ok: false, reason: 'no-location' };
}
