import { createUsdmDroughtLayer } from '../../layers/usdmDrought/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire U.S. Drought Monitor into the application catalog. */
export function createApplicationUsdmDrought(options) {
  return createUsdmDroughtLayer({ overlayHost, ...options });
}
