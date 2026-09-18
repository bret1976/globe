import * as Cesium from 'cesium';
import {
  resolveOperatorLocation,
  viewerCameraLatLon,
  nearestByHaversine,
  isFiniteLatLon,
  readCachedOperatorLocation,
} from '../data/operatorLocation.js';
import {
  layerFocusHeightM,
  planEnabledLayerFocus,
  pickImmediateOperatorFocus,
} from './layerFocusPlan.js';

export {
  LAYER_FOCUS_HEIGHT_M,
  SPACE_VIEW_HEIGHT_M,
  layerFocusHeightM,
  isUsableOperatorCameraHeight,
  pickImmediateOperatorFocus,
  shouldFocusUserEnabledLayer,
  planEnabledLayerFocus,
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

function flyToLatLon(viewer, lat, lon, heightM, durationSec = 1.8) {
  if (!viewer?.camera || !isFiniteLatLon(lat, lon)) return false;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-42),
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

export function snapViewerToLayerFocus(viewer, lat, lon, heightM) {
  if (!viewer?.camera || !isFiniteLatLon(lat, lon)) return false;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-42),
      roll: 0,
    },
  });
  return true;
}

/**
 * Move the camera to the operator at the layer's working height BEFORE enable
 * so viewport feeds (flights, traffic, CCTV, ALPR) query the right place.
 */
export async function prepareEnabledLayerFocus({
  viewer,
  layerId,
  resolveLocation = createOperatorLocationResolver(viewer),
} = {}) {
  if (!viewer?.camera) return { ok: false, reason: 'no-viewer' };
  if (
    typeof document !== 'undefined' &&
    document.body?.classList.contains('cockpit-mode')
  ) {
    return { ok: false, reason: 'cockpit' };
  }
  if (viewer.trackedEntity) return { ok: false, reason: 'tracking' };

  const heightM = layerFocusHeightM(layerId);
  const camera = resolveViewerOperatorFallback(viewer);
  const immediate = pickImmediateOperatorFocus({
    cached: readCachedOperatorLocation(),
    camera,
    cameraHeightM: viewer.camera.positionCartographic?.height,
  });
  if (immediate) {
    snapViewerToLayerFocus(viewer, immediate.lat, immediate.lon, heightM);
  }

  const location = await resolveLocation();
  if (location) {
    snapViewerToLayerFocus(viewer, location.lat, location.lon, heightM);
    return { ok: true, location };
  }
  return immediate
    ? { ok: true, location: immediate }
    : { ok: false, reason: 'no-location' };
}

/**
 * After a Data Layers row enable, go to the operator and then to that
 * layer's nearest data so flights / bikeshare / CCTV populate around them.
 */
export async function focusEnabledLayer({
  viewer,
  layerId,
  module,
  resolveLocation = createOperatorLocationResolver(viewer),
} = {}) {
  if (!viewer?.camera) return { ok: false, reason: 'no-viewer' };
  if (
    typeof document !== 'undefined' &&
    document.body?.classList.contains('cockpit-mode')
  ) {
    return { ok: false, reason: 'cockpit' };
  }
  if (viewer.trackedEntity) return { ok: false, reason: 'tracking' };

  const location = await resolveLocation();
  if (!location) return { ok: false, reason: 'no-location' };

  let nearestCameraId = null;
  if (layerId === 'cctv' && typeof module?.focusNearest === 'function') {
    nearestCameraId = module.focusNearest({
      focus: false,
      lat: location.lat,
      lon: location.lon,
    });
  }

  const objects =
    typeof module?.getDetectableObjects === 'function'
      ? module.getDetectableObjects({ maxCount: 2500 })
      : [];
  const nearestObject = pickNearestDetectable(
    objects,
    location.lat,
    location.lon,
  );

  const plan = planEnabledLayerFocus({
    layerId,
    location,
    nearestCameraId,
    hasAlprFocus:
      layerId === 'alpr-cameras' && typeof module?.focusNearest === 'function',
    nearestObject,
  });

  if (plan.mode === 'cctv') {
    module.focusCamera?.(plan.id, 1.8);
    return { ok: true, mode: 'cctv', id: plan.id, location };
  }

  if (plan.mode === 'alpr') {
    flyToLatLon(viewer, location.lat, location.lon, plan.heightM, 1.4);
    module.focusNearest();
    return { ok: true, mode: 'alpr', location };
  }

  if (plan.mode === 'object') {
    if (nearestObject?.position) {
      flyToCartesian(viewer, nearestObject.position, plan.heightM);
      return { ok: true, mode: 'object', id: plan.id, location };
    }
    const coords = objectLatLon(nearestObject);
    if (coords) {
      flyToLatLon(viewer, coords.lat, coords.lon, plan.heightM);
      return { ok: true, mode: 'object', id: plan.id, location };
    }
  }

  flyToLatLon(
    viewer,
    location.lat,
    location.lon,
    plan.heightM || layerFocusHeightM(layerId),
  );
  return { ok: true, mode: 'operator', location };
}
