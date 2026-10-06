import { createPowerPlantsLayer } from '../../layers/powerPlants/index.js';

/** Wire WRI utility-scale power plants into the application catalog. */
export function createApplicationPowerPlants(options) {
  return createPowerPlantsLayer(options);
}
