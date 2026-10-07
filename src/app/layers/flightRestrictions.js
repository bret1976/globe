import { createFlightRestrictionsLayer } from '../../layers/flightRestrictions/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire FAA temporary flight restrictions into the application catalog. */
export function createApplicationFlightRestrictions(options) {
  return createFlightRestrictionsLayer({ overlayHost, ...options });
}
