import { createSpcOutlookLayer } from '../../layers/spcOutlook/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire SPC convective outlook into the application catalog. */
export function createApplicationSpcOutlook(options) {
  return createSpcOutlookLayer({ overlayHost, ...options });
}
