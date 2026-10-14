import { isConstrainedGlobeClient } from './clientCapabilities.js';

/** Cap the Cesium backing-store scale so HUD/cockpit views stay sharp on retina. */
export function viewerResolutionScale(
  devicePixelRatio = 1,
  { constrained = false } = {},
) {
  const ratio = Number(devicePixelRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  // Phones already multiply by window.devicePixelRatio; a further 2× scale
  // builds a ~6× framebuffer (e.g. 2340×5064 on an iPhone) that Safari kills.
  // Desktop also stays at 1: Cesium already renders at native devicePixelRatio
  // (useBrowserRecommendedResolution = false), so >1 supersampled on top of it.
  void constrained;
  return 1;
}

/** Force native-resolution rendering instead of Cesium's performance downsample. */
export function applyViewerPresentation(
  viewer,
  { devicePixelRatio, constrained } = {},
) {
  if (!viewer) return viewer;
  const isConstrained =
    constrained ??
    isConstrainedGlobeClient({
      devicePixelRatio: devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
    });
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = viewerResolutionScale(
    devicePixelRatio ?? globalThis.devicePixelRatio ?? 1,
    { constrained: isConstrained },
  );
  if (viewer.scene) {
    // MSAA 8 × a retina phone framebuffer OOMs WebKit; desktop matches upstream (4).
    viewer.scene.msaaSamples = isConstrained ? 1 : 4;
    if (viewer.scene.postProcessStages?.fxaa) {
      viewer.scene.postProcessStages.fxaa.enabled = true;
    }
  }
  return viewer;
}
