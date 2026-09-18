import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configureGlobeFraming,
  GLOBE_CAMERA_MAX_ZOOM_M,
} from './globeFraming.js';

test('globe framing keeps Earth in view and still allows Reset Globe', () => {
  assert.ok(
    GLOBE_CAMERA_MAX_ZOOM_M > 18_000_000,
    'max zoom must remain above the Reset Globe height',
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
  assert.equal(controller.maximumZoomDistance, GLOBE_CAMERA_MAX_ZOOM_M);
  assert.equal(controller.enableCollisionDetection, true);
});
