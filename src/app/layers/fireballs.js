import { createFireballsLayer } from '../../layers/fireballs/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NASA JPL fireballs into the application catalog. */
export function createApplicationFireballs(options) {
  return createFireballsLayer({ overlayHost, ...options });
}
