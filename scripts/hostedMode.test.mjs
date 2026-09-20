import test from 'node:test';
import assert from 'node:assert/strict';
import { injectHostedClientKeys } from './hostedMode.mjs';

test('hosted HTML receives the runtime Cesium ion token', () => {
  const html = '<html><head><title>GEV</title></head><body></body></html>';
  const next = injectHostedClientKeys(html, {
    CESIUM_ION_TOKEN: 'ion-live-token',
    GOOGLE_MAPS_API_KEY: '',
  });
  assert.match(next, /window\.__GEV_CESIUM_ION_TOKEN="ion-live-token"/);
  assert.ok(next.indexOf('</head>') > next.indexOf('__GEV_CESIUM_ION_TOKEN'));
});

test('hosted HTML replacement stays a single script tag', () => {
  const first = injectHostedClientKeys('<html><head></head></html>', {
    CESIUM_ION_TOKEN: 'old',
  });
  const second = injectHostedClientKeys(first, { CESIUM_ION_TOKEN: 'new' });
  assert.equal(second.split('__GEV_CESIUM_ION_TOKEN').length - 1, 1);
  assert.match(second, /"new"/);
});
