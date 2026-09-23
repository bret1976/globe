/**
 * Where draped imagery can go on the current map stack. A globe stack drapes
 * on `viewer.imageryLayers`; a 3D-tiles stack hides the globe, and Cesium
 * 1.138 drapes imagery onto the tileset's own `imageryLayers` instead.
 *
 * Photoreal (Google 3D) on Cesium 1.124 hides the globe and has no tileset
 * imagery collection, which used to make Observed Weather / Recent Imagery
 * report "choose a globe map" on the exact view people actually use. Fall
 * back to the viewer collection and unhide a translucent globe so GIBS/HLS
 * can still drape.
 */

/** Guidance shown when the active map stack cannot host draped imagery. */
export const NO_IMAGERY_HOST = 'Hidden by this map source · choose a globe map';

/**
 * Resolve the imagery layer collection for the active map stack.
 * @param {{ viewer?: object, tileset?: object }} scene
 * @returns {{ collection: object | null, kind: 'globe' | 'tileset' | 'none' }}
 */
export function resolveImageryHost({ viewer, tileset } = {}) {
  if (viewer?.scene?.globe?.show === true && viewer.imageryLayers) {
    return { collection: viewer.imageryLayers, kind: 'globe' };
  }
  if (tileset?.imageryLayers && !tileset.isDestroyed?.()) {
    return { collection: tileset.imageryLayers, kind: 'tileset' };
  }
  if (viewer?.imageryLayers) {
    const globe = viewer.scene?.globe;
    if (globe && globe.show === false) {
      globe.show = true;
      try {
        if (globe.translucency) globe.translucency.enabled = true;
      } catch {
        /* Cesium builds without translucency stay opaque */
      }
    }
    return { collection: viewer.imageryLayers, kind: 'globe' };
  }
  return { collection: null, kind: 'none' };
}
