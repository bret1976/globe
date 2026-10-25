import { createWentDarkLayer } from '../../layers/wentDark/index.js';

/** Wire the "went dark" ghost-marker layer into the application catalog. */
export function createApplicationWentDark(options) {
  return createWentDarkLayer(options);
}
