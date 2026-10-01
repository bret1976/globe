import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR,
  PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR,
  PHOTOREAL_DESKTOP_CACHE_BYTES,
  PHOTOREAL_MOBILE_CACHE_BYTES,
  createGoogleDirectTileset,
  createGoogleIonTileset,
} from './google3d.js';

test('photoreal tilesets request a sharper screen-space error than the SDK default', () => {
  assert.equal(PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR, 4);
  assert.ok(PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR > PHOTOREAL_MAXIMUM_SCREEN_SPACE_ERROR);
});

test('direct Google tileset passes the sharper error budget', async () => {
  const Cesium = {
    async createGooglePhotorealistic3DTileset(options) {
      return options;
    },
  };
  const options = await createGoogleDirectTileset(Cesium, 'browser-key', {
    constrained: false,
  });
  assert.equal(options.maximumScreenSpaceError, 4);
  assert.equal(options.key, 'browser-key');
});

test('direct Google tileset softens the error budget on phones', async () => {
  const Cesium = {
    async createGooglePhotorealistic3DTileset(options) {
      return options;
    },
  };
  const options = await createGoogleDirectTileset(Cesium, 'browser-key', {
    constrained: true,
  });
  assert.equal(options.maximumScreenSpaceError, PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR);
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
  const options = await createGoogleIonTileset(Cesium, 'ion-token', {
    constrained: false,
  });
  assert.equal(options.maximumScreenSpaceError, 4);
  assert.equal(options.enableCollision, true);
  assert.equal(options.cacheBytes, PHOTOREAL_DESKTOP_CACHE_BYTES);
});

test('ion Google tileset uses a Safari-safe cache on phones', async () => {
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
  const options = await createGoogleIonTileset(Cesium, 'ion-token', {
    constrained: true,
  });
  assert.equal(options.maximumScreenSpaceError, PHOTOREAL_MOBILE_SCREEN_SPACE_ERROR);
  assert.equal(options.cacheBytes, PHOTOREAL_MOBILE_CACHE_BYTES);
  assert.ok(options.cacheBytes < PHOTOREAL_DESKTOP_CACHE_BYTES);
});
