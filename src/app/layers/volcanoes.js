import { createVolcanoesLayer } from '../../layers/volcanoes/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire USGS elevated volcanoes into the application catalog. */
export function createApplicationVolcanoes(options) {
  return createVolcanoesLayer({ overlayHost, ...options });
}
