import * as Cesium from 'cesium';
import { resolveFlightViewQuery } from '../../data/adsbLolFallback.js';

export function flightViewQuery(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  return resolveFlightViewQuery(
    cartographic ? Cesium.Math.toDegrees(cartographic.latitude) : NaN,
    cartographic ? Cesium.Math.toDegrees(cartographic.longitude) : NaN,
  );
}

export function createController({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  function _flightQuery(viewer) {
    return flightViewQuery(viewer);
  }
  return { _abortActiveUpdates, _flightQuery };
}
