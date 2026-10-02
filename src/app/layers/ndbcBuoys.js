import { createNdbcBuoysLayer } from '../../layers/ndbcBuoys/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NDBC marine buoys into the application catalog. */
export function createApplicationNdbcBuoys(options) {
  return createNdbcBuoysLayer({ overlayHost, ...options });
}
