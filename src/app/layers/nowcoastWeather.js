import { createNowcoastLayer } from '../../layers/nowcoast/index.js';

/** NOAA nowCOAST MRMS radar drape (CONUS). */
export function createApplicationWeatherRadar(options) {
  return createNowcoastLayer({ id: 'weather-radar', ...options });
}

/** NOAA nowCOAST 15-minute lightning density drape. */
export function createApplicationWeatherLightning(options) {
  return createNowcoastLayer({ id: 'weather-lightning', ...options });
}

/** NOAA nowCOAST GOES-East/West longwave infrared drape. */
export function createApplicationWeatherSatellite(options) {
  return createNowcoastLayer({ id: 'weather-satellite', ...options });
}
