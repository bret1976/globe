import { createAirportDelaysLayer } from '../../layers/airportDelays/index.js';
import * as Cesium from 'cesium';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire FAA airport delays into the application catalog. */
export function createApplicationAirportDelays(options) {
  return createAirportDelaysLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
