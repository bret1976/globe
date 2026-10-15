import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  VOICE_ZOOM_MIN_CLEARANCE_M,
  zoomInHeightBudgetM,
} from './gevActions.js';

/** A camera at `heightM` over Austin looking down at `pitchDeg`. */
function stubViewer(heightM, pitchDeg, groundM = 0) {
  const lon = Cesium.Math.toRadians(-97.7431);
  const lat = Cesium.Math.toRadians(30.2672);
  const positionWC = Cesium.Cartesian3.fromRadians(lon, lat, heightM);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(positionWC);
  const pitch = Cesium.Math.toRadians(pitchDeg);
  const local = new Cesium.Cartesian3(0, Math.cos(pitch), Math.sin(pitch));
  const directionWC = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    local,
    new Cesium.Cartesian3(),
  );
  return {
    camera: {
      positionWC,
      directionWC,
      positionCartographic: new Cesium.Cartographic(lon, lat, heightM),
    },
    scene: { globe: { getHeight: () => groundM } },
  };
}

const heightAfter = (viewer, moveM) =>
  viewer.camera.positionCartographic.height -
  moveM * Math.sin(Cesium.Math.toRadians(30));

test('voice zoom-in from 600 m never drops below the 150 m floor', () => {
  let height = 600;
  for (let step = 0; step < 10; step += 1) {
    const viewer = stubViewer(height, -30);
    const budget = zoomInHeightBudgetM(viewer, 0.55);
    // Old behaviour asked for thousands of metres along an oblique ray.
    height = heightAfter(viewer, Math.min(5000, budget));
    assert.ok(height >= VOICE_ZOOM_MIN_CLEARANCE_M - 1e-6, `step ${step}: ${height}`);
  }
  assert.ok(height < 200, 'repeated zoom-in converges toward the floor');
});

test('zoom-in budget scales with the step and respects terrain', () => {
  const little = zoomInHeightBudgetM(stubViewer(600, -90), 0.25);
  const medium = zoomInHeightBudgetM(stubViewer(600, -90), 0.55);
  assert.ok(Math.abs(little - 450 * 0.25) < 1);
  assert.ok(Math.abs(medium - 450 * 0.55) < 1);
  assert.equal(zoomInHeightBudgetM(stubViewer(600, -90, 500), 0.55), 0);
  assert.equal(zoomInHeightBudgetM(stubViewer(600, 10), 0.55), Infinity);
});
