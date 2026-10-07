import { createRadiosondesLayer } from '../../layers/radiosondes/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire SondeHub live radiosondes into the application catalog. */
export function createApplicationRadiosondes(options) {
  return createRadiosondesLayer({ overlayHost, ...options });
}
