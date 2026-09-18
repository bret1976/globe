import * as Cesium from 'cesium';
import {
  resolveOperatorLocation,
  resolveOperatorLocationFast,
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
} from './layerFocusPlan.js';

export {
  LAYER_FOCUS_HEIGHT_M,
  SPACE_VIEW_HEIGHT_M,
  MAX_CCTV_NEAREST_KM,
  layerFocusHeightM,
  layerFocusPitchDeg,
  isUsableOperatorCameraHeight,
  isNearbyOperatorFocus,
  pickImmediateOperatorFocus,
  shouldFocusUserEnabledLayer,
  planEnabledLayerFocus,
  collectLayerFocusObjects,
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
 * Move the camera to the operator at the layer's working height BEFORE enable
 * so viewport feeds (flights, traffic, CCTV, ALPR) query the right place.
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

  const heightM = layerFocusHeightM(layerId);
  const pitchDeg = layerFocusPitchDeg(layerId);
  const camera = resolveViewerOperatorFallback(viewer);
  const immediate = pickImmediateOperatorFocus({
    cached: readCachedOperatorLocation(),
    camera,
    cameraHeightM: viewer.camera.positionCartographic?.height,
  });
  primeOperatorLocation({ fallback: camera });
  const location = immediate || camera;
  if (location) {
    snapViewerToLayerFocus(
      viewer,
      location.lat,
      location.lon,
      heightM,
      pitchDeg,
    );
    return { ok: true, location };
  }
  return { ok: false, reason: 'no-location' };
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
  abortShortsPack();
  releaseStaleTracking(viewer);

  const location =
    (await resolveOperatorLocationFast({
      fallback: resolveViewerOperatorFallback(viewer),
    })) || (await resolveLocation());
  if (!location) return { ok: false, reason: 'no-location' };

  let nearestCameraId = null;
  let nearestCameraDistKm = null;
  if (layerId === 'cctv') {
    const nearest =
      typeof module?.nearestCameraToLatLon === 'function'
        ? module.nearestCameraToLatLon(location.lat, location.lon)
        : null;
    nearestCameraId = nearest?.id || null;
    nearestCameraDistKm = nearest?.distKm ?? null;
    if (!nearestCameraId && typeof module?.focusNearest === 'function') {
      nearestCameraId = module.focusNearest({
        focus: false,
        lat: location.lat,
        lon: location.lon,
      });
    }
  }

  const objects = collectFocusObjects(module);
  const nearestObject = pickNearestDetectable(
    objects,
    location.lat,
    location.lon,
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
    flyToLatLon(
      viewer,
      location.lat,
      location.lon,
      plan.heightM,
      1.4,
      layerFocusPitchDeg(layerId),
    );
    module.focusNearest();
    return { ok: true, mode: 'alpr', location };
  }

  if (
    layerId === 'rocket-launches' &&
    typeof module?.focusNearest === 'function'
  ) {
    const id = module.focusNearest({
      lat: location.lat,
      lon: location.lon,
    });
    if (id) return { ok: true, mode: 'launch', id, location };
  }

  if (
    layerId === 'ais-live-vessels' &&
    typeof module?.focusNearest === 'function'
  ) {
    const id = module.focusNearest({
      lat: location.lat,
      lon: location.lon,
    });
    const selected = module.getSelectedInfo?.();
    if (
      id &&
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
      return { ok: true, mode: 'vessel', id, location };
    }
    if (id) return { ok: true, mode: 'vessel', id, location };
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

  flyToLatLon(
    viewer,
    location.lat,
    location.lon,
    plan.heightM || layerFocusHeightM(layerId),
    1.8,
    layerFocusPitchDeg(layerId),
  );
  return { ok: true, mode: 'operator', location };
}
