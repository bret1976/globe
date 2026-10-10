import * as Cesium from 'cesium';
import { createHurricaneConesLayer } from '../../layers/hurricaneCones/index.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire NOAA/NHC forecast cones into the application catalog. */
export function createApplicationHurricaneCones(options) {
  return createHurricaneConesLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
