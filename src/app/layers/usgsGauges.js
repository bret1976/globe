import { createUsgsGaugesLayer } from '../../layers/usgsGauges/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire USGS stream gauges into the application catalog. */
export function createApplicationUsgsGauges(options) {
  return createUsgsGaugesLayer({ overlayHost, ...options });
}
