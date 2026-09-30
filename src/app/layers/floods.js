import { createFloodsLayer } from '../../layers/floods/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire GDACS floods & droughts into the application catalog. */
export function createApplicationFloods(options) {
  return createFloodsLayer({ overlayHost, ...options });
}
