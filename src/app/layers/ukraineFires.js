import { createUkraineFiresLayer } from '../../layers/ukraineFires/index.js';

/** Wire NASA FIRMS Ukraine war fire detections into the application catalog. */
export function createApplicationUkraineFires(options) {
  return createUkraineFiresLayer(options);
}
