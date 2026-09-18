/** Keep a full-earth framing possible (Reset Globe is 18,000 km).
 *  These constants document the intended envelope; they are not applied to
 *  Cesium's camera controller. Collision + zoom caps made the globe sticky. */
export const GLOBE_CAMERA_MAX_ZOOM_M = 20_000_000;
export const GLOBE_CAMERA_MIN_ZOOM_M = 20;

/** Show Earth/ocean immediately. Photoreal stacks may hide the globe later.
 *  Leave the default camera controller alone so wheel / pinch zoom stay free. */
export function configureGlobeFraming(viewer) {
  if (!viewer?.scene) return viewer;
  if (viewer.scene.globe) viewer.scene.globe.show = true;
  return viewer;
}
