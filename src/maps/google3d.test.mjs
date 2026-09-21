import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR,
  createGoogleDirectTileset,
  createGoogleIonTileset,
} from './google3d.js';

test('photoreal tilesets request a sharper screen-space error than the SDK default', () => {
  assert.equal(PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR, 4);
});

test('direct Google tileset passes the sharper error budget', async () => {
  const Cesium = {
    async createGooglePhotorealistic3DTileset(options) {
      return options;
    },
  };
  const options = await createGoogleDirectTileset(Cesium, 'browser-key');
  assert.equal(options.maximumScreenSpaceError, 4);
  assert.equal(options.key, 'browser-key');
});

test('ion Google tileset passes the sharper error budget', async () => {
  const Cesium = {
    IonResource: {
      async fromAssetId() {
        return 'ion://2275207';
      },
    },
    Cesium3DTileset: {
      async fromUrl(_resource, options) {
        return options;
      },
    },
  };
  const options = await createGoogleIonTileset(Cesium, 'ion-token');
  assert.equal(options.maximumScreenSpaceError, 4);
  assert.equal(options.enableCollision, true);
});
