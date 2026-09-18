import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureGlobeFraming,
  GLOBE_CAMERA_MAX_ZOOM_M,
} from './globeFraming.js';

test('globe framing shows Earth and leaves the camera controller alone', () => {
  assert.ok(
    GLOBE_CAMERA_MAX_ZOOM_M > 18_000_000,
    'Reset Globe height stays documented above 18,000 km',
  );
  const controller = {
    maximumZoomDistance: Number.POSITIVE_INFINITY,
    minimumZoomDistance: 1,
    enableCollisionDetection: false,
  };
  const viewer = {
    scene: { globe: { show: false }, screenSpaceCameraController: controller },
  };
  configureGlobeFraming(viewer);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(controller.maximumZoomDistance, Number.POSITIVE_INFINITY);
  assert.equal(controller.minimumZoomDistance, 1);
  assert.equal(controller.enableCollisionDetection, false);
});
