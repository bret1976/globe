import { createRadiationLayer } from '../../layers/radiation/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire Safecast radiation into the application catalog. */
export function createApplicationRadiation(options) {
  return createRadiationLayer({ overlayHost, ...options });
}
