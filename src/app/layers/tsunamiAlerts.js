import { createTsunamiAlertsLayer } from '../../layers/tsunamiAlerts/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NOAA tsunami.gov alerts into the application catalog. */
export function createApplicationTsunamiAlerts(options) {
  return createTsunamiAlertsLayer({ overlayHost, ...options });
}
