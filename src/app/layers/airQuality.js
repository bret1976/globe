import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire Sensor.Community air quality into the application catalog. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({ overlayHost, ...options });
}
