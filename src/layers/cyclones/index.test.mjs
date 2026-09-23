import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyclonesLayer, CYCLONE_LAYER_ID } from './index.js';

function fakeCesium() {
  const entities = [];
  return {
    Color: {
      WHITE: { withAlpha: () => ({}) },
      BLACK: { withAlpha: () => ({}) },
      fromCssColorString: () => ({ withAlpha: () => ({}) }),
    },
    Color: undefined,
    Cartesian3: { fromDegrees: (...args) => args },
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    LabelStyle: { FILL_AND_OUTLINE: 2 },
    HeightReference: { CLAMP_TO_GROUND: 1 },
    CustomDataSource: class {
      constructor() {
        this.show = false;
        this.entities = {
          removeAll() {
            entities.length = 0;
          },
          add(entry) {
            entities.push(entry);
            return entry;
          },
        };
      }
    },
    entities,
  };
}

test('cyclone layer draws selected storms and row chips', async () => {
  const Color = {
    WHITE: { withAlpha: () => ({}) },
    BLACK: { withAlpha: () => ({}) },
    fromCssColorString: () => ({ withAlpha: () => ({}) }),
  };
  const cesium = {
    Color,
    Cartesian3: { fromDegrees: (...args) => args },
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    LabelStyle: { FILL_AND_OUTLINE: 2 },
    HeightReference: { CLAMP_TO_GROUND: 1 },
    CustomDataSource: class {
      constructor() {
        this.show = false;
        this.entities = {
          items: [],
          removeAll() {
            this.items.length = 0;
          },
          add(entry) {
            this.items.push(entry);
            return entry;
          },
        };
      }
    },
  };
  const layer = createCyclonesLayer({
    cesium,
    source: {
      async getSnapshot() {
        return {
          storms: [
            {
              id: 'eonet:1',
              name: 'Dujuan',
              lon: 138.5,
              lat: 24.2,
              windKt: 80,
              classification: 'TY',
              track: [
                { lon: 137, lat: 22 },
                { lon: 138.5, lat: 24.2 },
              ],
            },
          ],
        };
      },
    },
  });
  assert.equal(layer.id, CYCLONE_LAYER_ID);
  const viewer = { dataSources: { add() {}, remove() {} } };
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getRowControls().chips[0].label, 'Dujuan');
  assert.equal(layer.setParams({ selected: 'eonet:1' }), true);
  assert.equal(layer.getParams().selected, 'eonet:1');
  layer.destroy(viewer);
});
