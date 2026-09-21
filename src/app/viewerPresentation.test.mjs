import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyViewerPresentation,
  viewerResolutionScale,
} from './viewerPresentation.js';

test('viewer resolution scale stays at least 1x and caps retina at 2x', () => {
  assert.equal(viewerResolutionScale(1), 1);
  assert.equal(viewerResolutionScale(1.5), 1.5);
  assert.equal(viewerResolutionScale(3), 2);
  assert.equal(viewerResolutionScale(0), 1);
  assert.equal(viewerResolutionScale(Number.NaN), 1);
});

test('applyViewerPresentation disables browser-recommended downsampling', () => {
  const viewer = {
    scene: {
      msaaSamples: 4,
      postProcessStages: { fxaa: { enabled: false } },
    },
  };
  applyViewerPresentation(viewer, { devicePixelRatio: 2 });
  assert.equal(viewer.useBrowserRecommendedResolution, false);
  assert.equal(viewer.resolutionScale, 2);
  assert.equal(viewer.scene.msaaSamples, 8);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, true);
});
