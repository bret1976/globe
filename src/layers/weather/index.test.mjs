import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherLayer, WEATHER_LAYER_ID } from './index.js';

test('observed weather drapes IR on a globe host and clears on disable', () => {
  const added = [];
  const collection = {
    add(layer) {
      added.push(layer);
    },
    remove(layer) {
      const index = added.indexOf(layer);
      if (index >= 0) added.splice(index, 1);
    },
  };
  const layer = createWeatherLayer({
    cesium: {
      UrlTemplateImageryProvider: class {
        constructor(options) {
          this.url = options.url;
        }
      },
      WebMercatorTilingScheme: class {},
      ImageryLayer: class {
        constructor(provider) {
          this.provider = provider;
        }
      },
      Rectangle: { fromDegrees: (...args) => args },
    },
    host: () => ({ collection, kind: 'globe' }),
    now: () => new Date('2026-09-23T12:00:00Z'),
  });
  assert.equal(layer.id, WEATHER_LAYER_ID);
  layer.init({});
  layer.enable();
  assert.equal(added.length, 2);
  assert.match(added[0].provider.url, /VIIRS_NOAA21_Brightness_Temp_BandI5_Day/);
  assert.match(added[1].provider.url, /Himawari_AHI_Band13_CleanInfrared/);
  layer.disable();
  assert.equal(added.length, 0);
  layer.destroy();
});
