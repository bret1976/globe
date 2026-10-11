import { createSpcOutlookLayer } from '../../layers/spcOutlook/index.js';
import * as Cesium from 'cesium';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire SPC convective outlook into the application catalog. */
export function createApplicationSpcOutlook(options) {
  return createSpcOutlookLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
