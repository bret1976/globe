import { createGpsInterferenceLayer } from '../../layers/gpsInterference/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire gpsjam.org GNSS interference hexes into the application catalog. */
export function createApplicationGpsInterference(options) {
  return createGpsInterferenceLayer({ overlayHost, ...options });
}
