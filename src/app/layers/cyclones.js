import { createCyclonesLayer } from '../../layers/cyclones/index.js';

/** Bind a supplied cyclone snapshot feed to the globe overlay. */
export function createApplicationCyclones({ source, ...options } = {}) {
  return createCyclonesLayer({ source, ...options });
}
