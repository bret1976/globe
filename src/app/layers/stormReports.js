import { createStormReportsLayer } from '../../layers/stormReports/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NWS local storm reports into the application catalog. */
export function createApplicationStormReports(options) {
  return createStormReportsLayer({ overlayHost, ...options });
}
