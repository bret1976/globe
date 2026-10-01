import { createNwsAlertsLayer } from '../../layers/nwsAlerts/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NWS weather alerts into the application catalog. */
export function createApplicationNwsAlerts(options) {
  return createNwsAlertsLayer({ overlayHost, ...options });
}
