import { createTideGaugesLayer } from '../../layers/tideGauges/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NOAA tide gauges into the application catalog. */
export function createApplicationTideGauges(options) {
  return createTideGaugesLayer({ overlayHost, ...options });
}
