import { createAviationHazardsLayer } from '../../layers/aviationHazards/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire Aviation Weather Center hazards into the application catalog. */
export function createApplicationAviationHazards(options) {
  return createAviationHazardsLayer({ overlayHost, ...options });
}
