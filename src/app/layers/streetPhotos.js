import { createStreetPhotosLayer } from '../../layers/streetPhotos/index.js';

/** Wire Panoramax street-level photos into the application catalog. */
export function createApplicationStreetPhotos(options = {}) {
  return createStreetPhotosLayer(options);
}
