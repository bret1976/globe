/** Keep a full-earth framing possible (Reset Globe is 18,000 km) without
 *  letting inertia / auto-zoom fly the camera into empty space. */
export const GLOBE_CAMERA_MAX_ZOOM_M = 20_000_000;
export const GLOBE_CAMERA_MIN_ZOOM_M = 20;

/** Show Earth/ocean immediately and cap zoom so the planet stays in frame.
 *  Photoreal stacks may hide the globe later; this only owns boot framing. */
export function configureGlobeFraming(viewer) {
  if (!viewer?.scene) return viewer;
  if (viewer.scene.globe) viewer.scene.globe.show = true;
  const controller = viewer.scene.screenSpaceCameraController;
  if (controller) {
    controller.maximumZoomDistance = GLOBE_CAMERA_MAX_ZOOM_M;
    controller.minimumZoomDistance = GLOBE_CAMERA_MIN_ZOOM_M;
    controller.enableCollisionDetection = true;
  }
  return viewer;
}
