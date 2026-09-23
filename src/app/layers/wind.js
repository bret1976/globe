import { createWindLayer } from '../../layers/wind/index.js';

/** Bind a supplied wind snapshot feed to the globe overlay. */
export function createApplicationWind({ source, ...options } = {}) {
  return createWindLayer({ source, ...options });
}
