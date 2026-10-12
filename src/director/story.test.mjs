import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneDocument, stringifySceneDocument } from './document.js';
import {
  estimateNarrationSec,
  imageryTileTemplate,
  nearestWaybackRelease,
  parseWaybackReleases,
} from './story.js';

const project = (story) => ({
  version: 6,
  scenes: [
    {
      id: 's',
      title: 'S',
      shots: [
        { id: 'a', title: 'A', camera: { lat: 1, lon: 2, alt: 3 }, story },
      ],
    },
  ],
});
const full = {
  caption: { title: 'Flood', text: 'Line', position: 'bottom' },
  narration: { text: 'Hello world', rate: 1 },
  media: {
    kind: 'video',
    src: 'https://example.com/a.mp4',
    lat: 28.1,
    lon: 85.3,
    label: 'Witness',
  },
  compare: {
    before: { source: 'wayback', release: 26334, label: '2021-01-01' },
    after: { source: 'esri' },
    split: 0.5,
    sweep: true,
  },
};

test('story round-trips through the scene document', () => {
  const text = stringifySceneDocument(project(full));
  assert.deepEqual(parseSceneDocument(text).scenes[0].shots[0].story, full);
});

test('story rejects unsafe or malformed media and unknown fields', () => {
  for (const media of [
    { ...full.media, src: 'javascript:alert(1)' },
    { ...full.media, src: 'http://example.com/a.mp4' },
    { ...full.media, lat: 120 },
    { ...full.media, kind: 'html' },
  ])
    assert.throws(() => parseSceneDocument(JSON.stringify(project({ media }))));
  assert.throws(() =>
    parseSceneDocument(JSON.stringify(project({ script: 'x' }))),
  );
  assert.throws(() =>
    parseSceneDocument(
      JSON.stringify(
        project({
          compare: { before: { source: 'wayback' }, after: { source: 'esri' } },
        }),
      ),
    ),
  );
  parseSceneDocument(
    JSON.stringify(
      project({
        media: {
          ...full.media,
          kind: 'image',
          src: 'data:image/jpeg;base64,AAAA',
        },
      }),
    ),
  );
  parseSceneDocument(
    JSON.stringify(
      project({ media: { ...full.media, src: 'upload:v-abc123' } }),
    ),
  );
});

test('story helpers', () => {
  assert.ok(estimateNarrationSec(full) > 0);
  assert.equal(estimateNarrationSec({}), 0);
  assert.match(
    imageryTileTemplate({ source: 'wayback', release: 5 }),
    /tile\/5\/\{z\}/,
  );
  const releases = parseWaybackReleases({
    1: { itemTitle: 'World Imagery (Wayback 2020-01-08)' },
    2: { itemTitle: 'World Imagery (Wayback 2024-06-01)' },
  });
  assert.equal(releases[0].release, 2);
  assert.equal(nearestWaybackRelease(releases, '2019-05-01').release, 1);
});
