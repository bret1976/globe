import { createIonosphereLayer } from '../../layers/ionosphere/index.js';

/** Wire NOAA SWPC GloTEC ionosphere TEC into the application catalog. */
export function createApplicationIonosphere(options) {
  return createIonosphereLayer(options);
}
