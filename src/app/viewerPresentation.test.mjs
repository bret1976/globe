import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyViewerPresentation,
  viewerResolutionScale,
} from './viewerPresentation.js';

test('viewer resolution scale stays at 1x (Cesium already renders at native DPR)', () => {
  assert.equal(viewerResolutionScale(1), 1);
  assert.equal(viewerResolutionScale(1.5), 1);
  assert.equal(viewerResolutionScale(3), 1);
  assert.equal(viewerResolutionScale(0), 1);
  assert.equal(viewerResolutionScale(Number.NaN), 1);
});

test('constrained clients cap the effective DPR at 2', () => {
  assert.equal(viewerResolutionScale(3, { constrained: true }), 2 / 3);
  assert.equal(viewerResolutionScale(2.625, { constrained: true }), 2 / 2.625);
  assert.equal(viewerResolutionScale(2, { constrained: true }), 1);
  assert.equal(viewerResolutionScale(1, { constrained: true }), 1);
});

test('applyViewerPresentation disables browser-recommended downsampling', () => {
  const viewer = {
    scene: {
      msaaSamples: 4,
      postProcessStages: { fxaa: { enabled: false } },
    },
  };
  applyViewerPresentation(viewer, {
    devicePixelRatio: 2,
    constrained: false,
  });
  assert.equal(viewer.useBrowserRecommendedResolution, false);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.msaaSamples, 4);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, true);
});

test('applyViewerPresentation softens MSAA and scale on constrained clients', () => {
  const viewer = {
    scene: {
      msaaSamples: 4,
      postProcessStages: { fxaa: { enabled: false } },
    },
  };
  applyViewerPresentation(viewer, {
    devicePixelRatio: 3,
    constrained: true,
  });
  assert.equal(viewer.resolutionScale, 2 / 3);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.scene.postProcessStages.fxaa.enabled, true);
});
