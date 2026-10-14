import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleHeightBudgeted,
  heightBudgetSpent,
  cachedHeight,
  _resetHeightBudget,
} from './heightBudget.js';

const carto = (latDeg, lonDeg) => ({
  latitude: (latDeg * Math.PI) / 180,
  longitude: (lonDeg * Math.PI) / 180,
});

function slowScene(costMs, height = 42) {
  const scene = {
    sampleHeightSupported: true,
    frameState: { frameNumber: 1 },
    calls: 0,
  };
  scene.sampleHeight = () => {
    scene.calls++;
    const end = performance.now() + costMs;
    while (performance.now() < end) {
      /* burn */
    }
    return height;
  };
  return scene;
}

test('a slow pick spends the rolling budget so later frames skip sampling', () => {
  _resetHeightBudget();
  const scene = slowScene(35);
  assert.equal(
    sampleHeightBudgeted(scene, carto(1, 1), null, { useCache: false }),
    42,
  );
  scene.frameState.frameNumber = 2;
  assert.equal(heightBudgetSpent(scene), true);
  assert.equal(
    sampleHeightBudgeted(scene, carto(2, 2), null, { useCache: false }),
    undefined,
  );
  assert.equal(scene.calls, 1);
});

test('cheap picks are cached per cell and capped per frame', () => {
  _resetHeightBudget();
  const scene = slowScene(0, 7);
  assert.equal(sampleHeightBudgeted(scene, carto(10, 10)), 7);
  assert.equal(cachedHeight(carto(10.0001, 10.0001)), 7);
  assert.equal(sampleHeightBudgeted(scene, carto(10.0001, 10.0001)), 7);
  assert.equal(scene.calls, 1);
});

test('unsupported scenes never sample', () => {
  _resetHeightBudget();
  assert.equal(
    sampleHeightBudgeted({ sampleHeightSupported: false }, carto(0, 0)),
    undefined,
  );
  assert.equal(sampleHeightBudgeted(null, carto(0, 0)), undefined);
});
