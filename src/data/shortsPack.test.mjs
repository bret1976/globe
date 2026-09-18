import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  parseShortsPackFromLocation,
  runShortsPack,
  SHORTS_ALIASES,
  SHORTS_PACK_VERSION,
} from './shortsPack.js';

function loc({ hash = '', search = '' } = {}) {
  return { hash, search };
}

function mockDom() {
  const originalDocument = globalThis.document;
  const originalMatchMedia = globalThis.matchMedia;
  const toast = {
    textContent: '',
    classList: { add() {}, remove() {} },
  };
  const badge = {
    id: 'shorts-pack-badge',
    textContent: '',
    style: { cssText: '' },
    setAttribute() {},
  };
  const elements = { toast, 'shorts-pack-badge': null };
  globalThis.document = {
    getElementById(id) {
      return elements[id] || null;
    },
    createElement() {
      return badge;
    },
    body: {
      appendChild(node) {
        elements[node.id] = node;
        return node;
      },
    },
  };
  globalThis.matchMedia = () => ({ matches: true });
  return {
    toast,
    badge,
    restore() {
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalMatchMedia === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = originalMatchMedia;
    },
  };
}

function mockViewer() {
  const hops = [];
  return {
    hops,
    viewer: {
      camera: {
        flyTo(options) {
          hops.push(options);
          options.complete?.();
        },
      },
    },
  };
}

test('traffic aliases resolve from hash or search', () => {
  assert.equal(SHORTS_PACK_VERSION, '2026-09-18-traffic-cctv');
  assert.equal(SHORTS_ALIASES.traffic, 'traffic');
  assert.equal(SHORTS_ALIASES.cctv, 'traffic');
  assert.equal(SHORTS_ALIASES.streets, 'traffic');
  assert.equal(SHORTS_ALIASES.tomtom, 'traffic');
  assert.equal(SHORTS_ALIASES.spy, 'traffic');
  assert.equal(parseShortsPackFromLocation(loc({ hash: '#shorts=traffic' })), 'traffic');
  assert.equal(parseShortsPackFromLocation(loc({ hash: '#shorts=cctv' })), 'traffic');
  assert.equal(parseShortsPackFromLocation(loc({ search: '?shorts=spy' })), 'traffic');
  assert.equal(parseShortsPackFromLocation(loc({ hash: '#shorts=bay' })), 'bay-area');
  assert.equal(parseShortsPackFromLocation(loc()), null);
});

test('traffic pack enables traffic + CCTV and hops Austin → London → SF', async () => {
  const dom = mockDom();
  const enabled = [];
  const { viewer, hops } = mockViewer();
  try {
    const pack = await runShortsPack({
      pack: 'traffic',
      viewer,
      dataManager: {
        async setEnabled(id, on, options) {
          enabled.push({ id, on, origin: options?.origin });
          return true;
        },
      },
    });
    assert.equal(pack, 'traffic');
    assert.deepEqual(enabled, [
      { id: 'traffic', on: true, origin: 'user' },
      { id: 'cctv', on: true, origin: 'user' },
    ]);
    assert.equal(hops.length, 3);
    const [austin, london, sf] = hops.map((hop) =>
      Cesium.Cartographic.fromCartesian(hop.destination),
    );
    assert.ok(Math.abs(Cesium.Math.toDegrees(austin.latitude) - 30.2747) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(austin.longitude) - -97.7403) < 0.001);
    assert.ok(Math.abs(austin.height - 42_000) < 1);
    assert.ok(Math.abs(Cesium.Math.toDegrees(london.latitude) - 51.5055) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(london.longitude) - -0.0754) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(sf.latitude) - 37.7952) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(sf.longitude) - -122.4028) < 0.001);
    assert.match(dom.toast.textContent, /Traffic & CCTV/);
    assert.match(dom.badge.textContent, /2026-09-18-traffic-cctv/);
  } finally {
    dom.restore();
  }
});
