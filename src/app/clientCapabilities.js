/**
 * Phone / coarse-pointer clients cannot afford the desktop WebGL budget
 * (2× DPR backing store, MSAA 8, multi-GB photoreal tile cache). Detect the
 * constrained class once so presentation and tileset loaders can shrink
 * without redesigning the HUD.
 */

/**
 * @param {{
 *   matchMedia?: typeof globalThis.matchMedia,
 *   devicePixelRatio?: number,
 *   maxTouchPoints?: number,
 *   userAgent?: string,
 * }} [env]
 * @returns {boolean}
 */
export function isConstrainedGlobeClient({
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  devicePixelRatio = globalThis.devicePixelRatio,
  maxTouchPoints = globalThis.navigator?.maxTouchPoints,
  userAgent = globalThis.navigator?.userAgent,
} = {}) {
  let narrow = false;
  let coarse = false;
  try {
    narrow = matchMedia?.('(max-width: 720px)')?.matches === true;
    coarse = matchMedia?.('(pointer: coarse)')?.matches === true;
  } catch {
    /* jsdom / odd hosts */
  }
  const touch = Number(maxTouchPoints) > 0;
  const highDpr = Number(devicePixelRatio) >= 2;
  const appleMobile = /iPhone|iPad|iPod/i.test(String(userAgent || ''));
  // Narrow phones, iOS (incl. iPad), or coarse+touch retina devices.
  return Boolean(narrow || appleMobile || (coarse && touch && highDpr));
}
