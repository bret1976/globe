import { createAirportDelaysLayer } from '../../layers/airportDelays/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire FAA airport delays into the application catalog. */
export function createApplicationAirportDelays(options) {
  return createAirportDelaysLayer({ overlayHost, ...options });
}
