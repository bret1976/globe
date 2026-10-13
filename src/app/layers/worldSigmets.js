import { createWorldSigmetsLayer } from '../../layers/worldSigmets/index.js';
import * as Cesium from 'cesium';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire AWC international SIGMETs into the application catalog. */
export function createApplicationWorldSigmets(options) {
  return createWorldSigmetsLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
