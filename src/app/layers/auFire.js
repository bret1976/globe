import { createAuFireLayer } from '../../layers/auFire/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NSW RFS + VIC EMV fire incidents into the application catalog. */
export function createApplicationAuFire(options) {
  return createAuFireLayer({ overlayHost, ...options });
}
