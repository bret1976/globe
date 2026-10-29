import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateSourceCap,
  resolveCatalogCap,
} from '../../server/providers/cctv/cap.js';
import {
  CCTV_MAX_SOURCES_CEILING,
  CCTV_PACK_LAST_GOOD_MAX_AGE_MS,
  CCTV_SOURCE_CACHE_MS,
  DEFAULT_CCTV_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const pack = (name, count, prefix = name) => ({
  name,
  sources: Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    rank: i,
  })),
});

test('under the cap every pack is served whole, in merge order', () => {
  const { sources, packs } = allocateSourceCap(
    [pack('a', 3), pack('b', 2)],
    10,
  );
  assert.deepEqual(
    sources.map((s) => s.id),
    ['a-0', 'a-1', 'a-2', 'b-0', 'b-1'],
  );
  assert.deepEqual(packs, [
    { name: 'a', offered: 3, kept: 3 },
    { name: 'b', offered: 2, kept: 2 },
  ]);
});

test('over the cap the packs share it round-robin, and the last pack is never starved', () => {
  // The old positional slice kept the first N of [a..., b..., c...], which
  // deleted pack c entirely; the fair split thins every pack instead.
  const { sources, packs } = allocateSourceCap(
    [pack('a', 100), pack('b', 100), pack('c', 100)],
    9,
  );
  assert.equal(sources.length, 9);
  assert.deepEqual(
    packs.map((p) => p.kept),
    [3, 3, 3],
  );
  // Each pack contributes its own highest-priority cameras, in its own order.
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('c-')).map((s) => s.rank),
    [0, 1, 2],
  );
});

test('a duplicate inside one pack takes one slot, not two', () => {
  const dup = {
    name: 'file',
    sources: [{ id: 'x', v: 'old' }, { id: 'x', v: 'new' }, { id: 'y' }],
  };
  const { sources } = allocateSourceCap([dup], 2);
  assert.deepEqual(
    sources.map((s) => [s.id, s.v]),
    [
      ['x', 'new'],
      ['y', undefined],
    ],
  );
});

test('a short pack releases its turns to the others', () => {
  const { packs } = allocateSourceCap([pack('a', 2), pack('b', 50)], 10);
  assert.deepEqual(
    packs.map((p) => p.kept),
    [2, 8],
  );
});

test('duplicate ids resolve last-pack-wins and count against the winning pack', () => {
  const live = {
    name: 'live',
    sources: [{ id: 'cam-1', label: 'live' }, { id: 'cam-2' }],
  };
  const override = {
    name: 'env',
    sources: [{ id: 'cam-1', label: 'override' }],
  };
  const { sources, packs } = allocateSourceCap([live, override], 10);
  assert.deepEqual(
    sources.map((s) => [s.id, s.label]),
    [
      ['cam-2', undefined],
      ['cam-1', 'override'],
    ],
  );
  assert.deepEqual(packs, [
    { name: 'live', offered: 1, kept: 1 },
    { name: 'env', offered: 1, kept: 1 },
  ]);
});

test('resolveCatalogCap bounds the env value and falls back to the default', () => {
  assert.equal(resolveCatalogCap(undefined), DEFAULT_CCTV_MAX_SOURCES);
  assert.equal(resolveCatalogCap('nonsense'), DEFAULT_CCTV_MAX_SOURCES);
  assert.equal(resolveCatalogCap('1'), 8);
  assert.equal(resolveCatalogCap('999999'), CCTV_MAX_SOURCES_CEILING);
  assert.equal(resolveCatalogCap('120.9'), 120);
});

test('the catalog applies the fair cap to configured packs end to end', async () => {
  const saved = { ...process.env };
  try {
    process.env.CCTV_PREFER_AUSTIN = '0';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({
        id: `env-${i}`,
        name: `Env ${i}`,
        lat: 30 + i * 0.01,
        lon: -97,
        url: `https://example.test/${i}.jpg`,
      })),
    );
    process.env.CCTV_MAX_SOURCES = '9';
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const sources = await getSources();
    assert.equal(sources.length, 9);
    assert.deepEqual(
      sources.slice(0, 3).map((s) => s.id),
      ['env-0', 'env-1', 'env-2'],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

// Background refresh tests ported from upstream gods-eye-view #1234
// (quanticsoul4772, MIT). This fork's live packs fall back to bundled
// snapshots when offline, so ids are filtered to the env pack's prefix.

/** A CCTV_SOURCES_JSON value with `count` cameras named `<prefix>-<i>`. */
const envSources = (prefix, count = 3) =>
  JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: `${prefix}-${i}`,
      name: `${prefix} ${i}`,
      lat: 30 + i * 0.01,
      lon: -97,
      url: `https://example.test/${prefix}-${i}.jpg`,
    })),
  );

/** Let a background refresh that needs no timers run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Restore process.env to a snapshot taken with `{ ...process.env }`. */
const restoreEnv = (saved) => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
};

const envIds = (list) =>
  list.map((s) => s.id).filter((id) => /^(old|new)-/.test(id));

test('an expired catalog is served at once while a slow pack refreshes in the background', async (t) => {
  const saved = { ...process.env };
  try {
    process.env.CCTV_FORCE_AUSTIN = '1';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = envSources('old');
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const hung = [];
    let hang = false;
    t.mock.method(globalThis, 'fetch', () =>
      hang
        ? new Promise((_, reject) => {
            hung.push(() => reject(new Error('upstream gave up')));
          })
        : Promise.reject(new Error('offline')),
    );
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    assert.deepEqual(envIds(await getSources()), ['old-0', 'old-1', 'old-2']);

    // Past the TTL, with every live pack's upstream hanging.
    now += CCTV_SOURCE_CACHE_MS + 1;
    hang = true;
    process.env.CCTV_SOURCES_JSON = envSources('new');
    let timer;
    const served = await Promise.race([
      getSources(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('waited'), 200);
      }),
    ]);
    clearTimeout(timer);
    assert.notEqual(served, 'waited', 'a stale request waited for the refresh');
    assert.deepEqual(envIds(served), ['old-0', 'old-1', 'old-2']);

    // Requests during the refresh share it rather than starting another.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    await pause();
    const inFlight = hung.length;
    assert.ok(inFlight > 0, 'the refresh reached the hanging upstreams');
    await getSources();
    await getSources();
    await pause();
    assert.equal(hung.length, inFlight, 'only one refresh ran');

    // When the slow packs give up, the refreshed catalog replaces the old one.
    hang = false;
    for (const giveUp of hung) giveUp();
    for (let i = 0; i < 50; i += 1) {
      if (envIds(await getSources())[0] === 'new-0') break;
      await pause();
    }
    assert.deepEqual(envIds(await getSources()), ['new-0', 'new-1', 'new-2']);
  } finally {
    restoreEnv(saved);
  }
});

test('a failed background refresh keeps the catalog, warns once, and waits a TTL to retry', async (t) => {
  const saved = { ...process.env };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    process.env.CCTV_PREFER_AUSTIN = '0';
    process.env.CCTV_FORCE_AUSTIN = '0';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = envSources('old', 9);
    process.env.CCTV_MAX_SOURCES = '8';
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    // Nine cameras over a cap of eight make every refresh warn; throwing from
    // that warning is how this test makes a refresh reject.
    let failRefresh = false;
    let failedRefreshes = 0;
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => {
      const text = args.join(' ');
      if (failRefresh && text.includes('exceeds cap')) {
        failedRefreshes += 1;
        throw new Error('refresh broke');
      }
      warnings.push(text);
    });
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const old = await getSources();
    assert.equal(old.length, 8);

    now += CCTV_SOURCE_CACHE_MS + 1;
    failRefresh = true;
    assert.equal(await getSources(), old);
    await settle();
    assert.equal(failedRefreshes, 1);
    assert.equal(
      warnings.filter((w) => w.includes('background catalog refresh failed'))
        .length,
      1,
    );

    // The failure is not retried on every request until the next TTL.
    assert.equal(await getSources(), old);
    assert.equal(await getSources(), old);
    await settle();
    assert.equal(failedRefreshes, 1, 'a failed refresh was retried at once');

    now += CCTV_SOURCE_CACHE_MS + 1;
    failRefresh = false;
    process.env.CCTV_SOURCES_JSON = envSources('new');
    await getSources();
    await settle();
    assert.deepEqual(envIds(await getSources()), ['new-0', 'new-1', 'new-2']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    restoreEnv(saved);
  }
});

const TARKTEE_LOCATIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>
<predefinedLocationContainer id="TRAFFIC_CAMERAS" version="0">
<predefinedLocation id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0">
<predefinedLocationName><values><value lang="et">Test Site</value></values></predefinedLocationName>
<location><pointByCoordinates><pointCoordinates><latitude>59.4370</latitude><longitude>24.7530</longitude></pointCoordinates></pointByCoordinates></location>
</predefinedLocation></predefinedLocationContainer></payloadPublication></d2LogicalModel>`;

const TARKTEE_IMAGES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>
<trafficView id="1"><linearTrafficView id="1">
<linearPredefinedLocationReference targetClass="PredefinedLocation" id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" version="0"/>
<trafficViewRecord id="1-1"><urlLink><urlLinkAddress>https://tarktee.transpordiamet.ee/images/42/42_202608251542.jpg</urlLinkAddress><urlLinkType>image</urlLinkType></urlLink></trafficViewRecord>
</linearTrafficView></trafficView></payloadPublication></d2LogicalModel>`;

test('a live pack whose refresh fails keeps its last good cameras for up to an hour', async (t) => {
  const saved = { ...process.env };
  try {
    process.env.CCTV_FORCE_AUSTIN = '1';
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    process.env.CCTV_SOURCES_JSON = '[]';
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'log', () => {});
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    let tarkteeUp = true;
    t.mock.method(globalThis, 'fetch', async (url) => {
      const href = String(url);
      if (tarkteeUp && href.includes('roadCameraLocations'))
        return new Response(TARKTEE_LOCATIONS_XML);
      if (tarkteeUp && href.includes('roadCameraImages'))
        return new Response(TARKTEE_IMAGES_XML);
      throw new Error('offline');
    });
    const isTarktee = (s) => String(s.url || '').includes('tarktee.transpordiamet.ee');
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });
    const first = await getSources();
    assert.equal(first.filter(isTarktee).length, 1, 'Tarktee loaded');

    // Next refresh Tarktee times out: its camera stays, with a warning.
    tarkteeUp = false;
    now += CCTV_SOURCE_CACHE_MS + 1;
    await getSources();
    let kept;
    for (let i = 0; i < 100; i += 1) {
      await settle();
      if (warnings.some((w) => w.includes('tarktee refresh returned no cameras'))) {
        kept = await getSources();
        break;
      }
    }
    assert.ok(kept, 'the refresh finished and kept Tarktee');
    assert.equal(kept.filter(isTarktee).length, 1);

    // Past the hour, a still-failing pack drops out.
    now += CCTV_PACK_LAST_GOOD_MAX_AGE_MS + 1;
    const before = warnings.length;
    await getSources();
    let dropped;
    for (let i = 0; i < 100; i += 1) {
      await settle();
      const list = await getSources();
      if (list !== kept) {
        dropped = list;
        break;
      }
    }
    assert.ok(dropped, 'a later refresh replaced the catalog');
    assert.equal(dropped.filter(isTarktee).length, 0);
    assert.ok(
      !warnings
        .slice(before)
        .some((w) => w.includes('tarktee refresh returned no cameras')),
    );
  } finally {
    restoreEnv(saved);
  }
});
