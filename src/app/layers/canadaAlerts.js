import { createCanadaAlertsLayer } from '../../layers/canadaAlerts/index.js';
import * as Cesium from 'cesium';
import { overlayHost } from './overlayHost.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire ECCC Canada weather alerts into the application catalog. */
export function createApplicationCanadaAlerts(options) {
  return createCanadaAlertsLayer({
    overlayHost,
    screenSpaceEventHandlerFactory: (viewer) =>
      new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
