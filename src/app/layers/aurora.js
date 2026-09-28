import { createAuroraLayer } from '../../layers/aurora/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NOAA SWPC OVATION aurora into the application catalog. */
export function createApplicationAurora(options) {
  return createAuroraLayer({ overlayHost, ...options });
}
