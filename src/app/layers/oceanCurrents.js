import { createOceanCurrentsLayer } from '../../layers/oceanCurrents/index.js';

/** Wire surface ocean currents into the application catalog. */
export function createApplicationOceanCurrents(options) {
  return createOceanCurrentsLayer(options);
}
