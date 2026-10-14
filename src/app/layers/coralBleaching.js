import { createCoralBleachingLayer } from '../../layers/coralBleaching/index.js';
import * as Cesium from 'cesium';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire NOAA Coral Reef Watch reef stations into the application catalog. */
export function createApplicationCoralBleaching(options) {
  return createCoralBleachingLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
