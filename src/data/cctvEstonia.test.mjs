import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTallinnSourcesFromCatalog,
  loadTarkteeSourcesFromDatex,
  parseTarkteeDatexImages,
  parseTarkteeDatexLocations,
  resetTarkteeLocationsCacheForTests,
} from '../../server/providers/cctv/sources.js';

const SAMPLE_LOCATIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <predefinedLocationContainer id="TRAFFIC_CAMERAS" version="0">
      <predefinedLocation id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0">
        <predefinedLocationName>
          <values><value lang="et">Test Site</value></values>
        </predefinedLocationName>
        <location>
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>59.4370</latitude>
              <longitude>24.7530</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </location>
      </predefinedLocation>
    </predefinedLocationContainer>
  </payloadPublication>
</d2LogicalModel>`;

const SAMPLE_IMAGES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
  <payloadPublication>
    <trafficView id="1">
      <linearTrafficView id="1">
        <linearPredefinedLocationReference targetClass="PredefinedLocation" id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0"/>
        <trafficViewRecord id="1-1">
          <urlLink>
            <urlLinkAddress>https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg</urlLinkAddress>
            <urlLinkType>image</urlLinkType>
          </urlLink>
        </trafficViewRecord>
      </linearTrafficView>
    </trafficView>
  </payloadPublication>
</d2LogicalModel>`;

test('Tallinn catalog loads curated ristmikud stills only', () => {
  const cameras = loadTallinnSourcesFromCatalog();
  assert.ok(
    cameras.length >= 200,
    `expected a full Tallinn pack, got ${cameras.length}`,
  );
  for (const camera of cameras.slice(0, 25)) {
    assert.match(camera.id, /^tln-/);
    assert.equal(camera.cityId, 'tallinn');
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.sourceKind, 'tallinn-ristmikud');
    assert.ok(camera.url.startsWith('https://ristmikud.tallinn.ee/'));
    assert.equal(camera.url, camera.snapshotUrl);
    assert.ok(Number.isFinite(camera.lat) && Number.isFinite(camera.lon));
  }
});

test('Tarktee DATEX parsers join location UUIDs to image URLs', () => {
  const locations = parseTarkteeDatexLocations(SAMPLE_LOCATIONS_XML);
  const images = parseTarkteeDatexImages(SAMPLE_IMAGES_XML);
  assert.equal(locations.size, 1);
  assert.equal(images.size, 1);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(locations.get(id)?.name, 'Test Site');
  assert.equal(locations.get(id)?.lat, 59.437);
  assert.equal(locations.get(id)?.lon, 24.753);
  assert.equal(
    images.get(id),
    'https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg',
  );
});

test('Tarktee DATEX image parser rejects non-official hosts', () => {
  const xml = SAMPLE_IMAGES_XML.replace(
    'https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg',
    'https://evil.example/images/42/42.jpg',
  );
  const images = parseTarkteeDatexImages(xml);
  assert.equal(images.size, 0);
});

// Ported from upstream gods-eye-view #1234 (quanticsoul4772, MIT).
test('Tarktee DATEX requests wait 45 s (slow locations) and 30 s (images)', async (t) => {
  resetTarkteeLocationsCacheForTests();
  const timeouts = [];
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return timeout.call(AbortSignal, ms);
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async (url) =>
      new Response(
        String(url).includes('roadCameraLocations')
          ? SAMPLE_LOCATIONS_XML
          : SAMPLE_IMAGES_XML,
      ),
  );
  const cameras = await loadTarkteeSourcesFromDatex();
  assert.deepEqual(timeouts, [45_000, 30_000]);
  assert.equal(cameras.length, 1);
});

test('a Tarktee locations timeout reuses the last good locations with fresh frames', async (t) => {
  resetTarkteeLocationsCacheForTests();
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  let failLocations = false;
  const freshImages = SAMPLE_IMAGES_XML.replace(
    '42_202608251542.jpg',
    '42_202608251600.jpg',
  );
  let images = SAMPLE_IMAGES_XML;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('roadCameraLocations')) {
      if (failLocations) throw new DOMException('timed out', 'TimeoutError');
      return new Response(SAMPLE_LOCATIONS_XML);
    }
    return new Response(images);
  });
  const first = await loadTarkteeSourcesFromDatex();
  assert.equal(first.length, 1);

  failLocations = true;
  images = freshImages;
  const second = await loadTarkteeSourcesFromDatex();
  assert.equal(second.length, 1);
  assert.equal(second[0].name, first[0].name);
  assert.match(second[0].url, /42_202608251600\.jpg$/);
  assert.ok(warnings.some((w) => w.includes('using the 1 cached')));
});

test('a Tarktee locations failure with nothing cached, or an images failure, returns empty', async (t) => {
  resetTarkteeLocationsCacheForTests();
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let mode = 'loc-fail';
  t.mock.method(globalThis, 'fetch', async (url) => {
    const isLoc = String(url).includes('roadCameraLocations');
    if (mode === 'loc-fail' && isLoc) return new Response('x', { status: 503 });
    if (mode === 'img-fail' && !isLoc) throw new Error('offline');
    return new Response(isLoc ? SAMPLE_LOCATIONS_XML : SAMPLE_IMAGES_XML);
  });
  assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
  mode = 'ok';
  assert.equal((await loadTarkteeSourcesFromDatex()).length, 1);
  mode = 'img-fail';
  assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
});
