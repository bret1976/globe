import { createWeatherLayer } from '../../layers/weather/index.js';

/** Wire the observed-weather GIBS drape into the application catalog. */
export function createApplicationWeather(options) {
  return createWeatherLayer(options);
}
