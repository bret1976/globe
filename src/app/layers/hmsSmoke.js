import { createHmsSmokeLayer } from '../../layers/hmsSmoke/index.js';
import * as Cesium from 'cesium';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire HMS smoke into the application catalog. */
export function createApplicationHmsSmoke(options) {
  return createHmsSmokeLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
