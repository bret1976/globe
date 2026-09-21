/** Cap the Cesium backing-store scale so HUD/cockpit views stay sharp on retina. */
export function viewerResolutionScale(devicePixelRatio = 1) {
  const ratio = Number(devicePixelRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(2, Math.max(1, ratio));
}

/** Force native-resolution rendering instead of Cesium's performance downsample. */
export function applyViewerPresentation(
  viewer,
  { devicePixelRatio } = {},
) {
  if (!viewer) return viewer;
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = viewerResolutionScale(
    devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
  );
  if (viewer.scene) {
    viewer.scene.msaaSamples = 8;
    if (viewer.scene.postProcessStages?.fxaa) {
      viewer.scene.postProcessStages.fxaa.enabled = true;
    }
  }
  return viewer;
}
