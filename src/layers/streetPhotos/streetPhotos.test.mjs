import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBoxFor, pictureIdFromPick, MAX_BOX_HALF_M } from './index.js';
import { photoCaption } from './viewer.js';
import { createPanoramaxSource } from './panoramax/source.js';
import { normalizeItem } from './panoramax/policy.js';
import { stacItem } from '../../testSupport/panoramaxFixtures.mjs';

test('search box is the view clipped to the centre box', () => {
  const box = searchBoxFor({ lon: 2.35, lat: 48.85 });
  const halfLat = MAX_BOX_HALF_M / 111_320;
  assert.ok(Math.abs(box.north - 48.85 - halfLat) < 1e-9);
  const clipped = searchBoxFor({
    lon: 2.35,
    lat: 48.85,
    rect: { west: 2.349, south: 48.849, east: 2.351, north: 48.851 },
  });
  assert.deepEqual(clipped, {
    west: 2.349,
    south: 48.849,
    east: 2.351,
    north: 48.851,
  });
  assert.equal(searchBoxFor({ lon: NaN, lat: 1 }), null);
  // A view rectangle that misses the centre box yields nothing.
  assert.equal(
    searchBoxFor({
      lon: 0,
      lat: 0,
      rect: { west: 10, south: 10, east: 11, north: 11 },
    }),
    null,
  );
});

test('only Panoramax picture dots are clickable', () => {
  assert.equal(pictureIdFromPick({ id: 'pnx:img:abc-1' }), 'abc-1');
  assert.equal(pictureIdFromPick({ id: 'cctv:1' }), null);
  assert.equal(pictureIdFromPick({ id: { foo: 1 } }), null);
  assert.equal(pictureIdFromPick(undefined), null);
});

test('itemsInBox asks the STAC search for a clamped bbox and limit', async () => {
  const urls = [];
  const source = createPanoramaxSource({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return new Response(JSON.stringify({ features: [{ id: 'a' }] }));
    },
  });
  const found = await source.itemsInBox({
    west: -200,
    south: 48,
    east: 2.5,
    north: 49,
    limit: 500,
  });
  assert.deepEqual(found, [{ id: 'a' }]);
  assert.equal(urls[0].pathname, '/api/search');
  assert.equal(
    urls[0].searchParams.get('bbox'),
    '-180.0000000,48.0000000,2.5000000,49.0000000',
  );
  assert.equal(urls[0].searchParams.get('limit'), '100');
  assert.deepEqual(
    await source.itemsInBox({ west: 3, south: 1, east: 2, north: 2 }),
    [],
  );
  assert.equal(urls.length, 1);
});

test('caption credits producer or instance, names the licence and links the viewer', () => {
  const pose = normalizeItem(stacItem({ id: 'pic-1', lon: 2.35, lat: 48.85 }));
  const caption = photoCaption(pose);
  assert.match(caption.href, /^https:\/\/api\.panoramax\.xyz\/#.*pic=pic-1/);
  assert.ok(caption.credit.startsWith('©') || caption.credit.startsWith('via'));
  assert.ok(caption.license);
  const anon = photoCaption({
    ...pose,
    creator: null,
    via: 'panoramax.ign.fr',
  });
  assert.equal(anon.credit, 'via panoramax.ign.fr');
  const bare = photoCaption({
    ...pose,
    creator: null,
    via: null,
    license: null,
  });
  assert.equal(bare.credit, '© Panoramax contributors');
  assert.equal(bare.license, 'licence: see Panoramax');
  assert.equal(photoCaption(null), null);
});
