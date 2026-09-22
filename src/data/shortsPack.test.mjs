import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  initShortsPack,
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
      dataset: {},
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
  assert.equal(SHORTS_PACK_VERSION, '2026-09-22-typhoon');
  assert.equal(SHORTS_ALIASES.traffic, 'traffic');
  assert.equal(SHORTS_ALIASES.cctv, undefined);
  assert.equal(SHORTS_ALIASES.streets, 'traffic');
  assert.equal(SHORTS_ALIASES.tomtom, 'traffic');
  assert.equal(SHORTS_ALIASES.spy, 'traffic');
  assert.equal(SHORTS_ALIASES.miami, 'miami-landing');
  assert.equal(SHORTS_ALIASES.typhoon, 'typhoon');
  assert.equal(SHORTS_ALIASES.dujuan, 'typhoon');
  assert.equal(SHORTS_ALIASES.storm, 'typhoon');
  assert.equal(SHORTS_ALIASES.himawari, 'typhoon');
  assert.equal(SHORTS_ALIASES['japan-storm'], 'typhoon');
  assert.equal(
    parseShortsPackFromLocation(loc({ hash: '#shorts=traffic' })),
    'traffic',
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ hash: '#shorts=cctv' })),
    null,
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ search: '?shorts=spy' })),
    'traffic',
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ hash: '#shorts=miami' })),
    'miami-landing',
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ hash: '#shorts=bay' })),
    'bay-area',
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ hash: '#shorts=typhoon' })),
    'typhoon',
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ hash: '#shorts=dujuan' })),
    'typhoon',
  );
  assert.equal(
    parseShortsPackFromLocation(loc({ search: '?shorts=japan-storm' })),
    'typhoon',
  );
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
      { id: 'traffic', on: true, origin: 'programmatic' },
      { id: 'cctv', on: true, origin: 'programmatic' },
    ]);
    assert.equal(hops.length, 3);
    const [austin, london, sf] = hops.map((hop) =>
      Cesium.Cartographic.fromCartesian(hop.destination),
    );
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(austin.latitude) - 30.2747) < 0.001,
    );
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(austin.longitude) - -97.7403) < 0.001,
    );
    assert.ok(Math.abs(austin.height - 42_000) < 1);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(london.latitude) - 51.5055) < 0.001,
    );
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(london.longitude) - -0.0754) < 0.001,
    );
    assert.ok(Math.abs(Cesium.Math.toDegrees(sf.latitude) - 37.7952) < 0.001);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(sf.longitude) - -122.4028) < 0.001,
    );
    assert.match(dom.toast.textContent, /Traffic & CCTV/);
    assert.match(dom.badge.textContent, /2026-09-22-typhoon/);
  } finally {
    dom.restore();
  }
});

test('miami landing pack flies ILS 30 and can be aborted mid-hop', async () => {
  const dom = mockDom();
  const enabled = [];
  const hops = [];
  const pending = [];
  const viewer = {
    camera: {
      flyTo(options) {
        hops.push(options);
        pending.push(options);
      },
    },
  };
  try {
    const { abortShortsPack, runShortsPack } = await import('./shortsPack.js');
    const running = runShortsPack({
      pack: 'miami-landing',
      viewer,
      dataManager: {
        async setEnabled(id, on, options) {
          enabled.push({ id, on, origin: options?.origin });
          return true;
        },
      },
    });
    for (let i = 0; i < 20 && hops.length === 0; i += 1) {
      await Promise.resolve();
    }
    assert.equal(enabled.length, 2);
    assert.equal(hops.length, 1);
    const mia = Cesium.Cartographic.fromCartesian(hops[0].destination);
    assert.ok(Math.abs(Cesium.Math.toDegrees(mia.latitude) - 25.795) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(mia.longitude) - -80.287) < 0.001);
    abortShortsPack();
    pending[0].complete?.();
    assert.equal(await running, 'miami-landing');
  } finally {
    dom.restore();
  }
});

test('aborting a shorts hop stops the traffic cinematic', async () => {
  const dom = mockDom();
  const hops = [];
  const pending = [];
  const viewer = {
    camera: {
      flyTo(options) {
        hops.push(options);
        pending.push(options);
      },
    },
  };
  try {
    const { abortShortsPack, runShortsPack } = await import('./shortsPack.js');
    const running = runShortsPack({
      pack: 'traffic',
      viewer,
      dataManager: {
        async setEnabled() {
          return true;
        },
      },
    });
    for (let i = 0; i < 20 && hops.length === 0; i += 1) {
      await Promise.resolve();
    }
    assert.equal(hops.length, 1);
    abortShortsPack();
    pending[0].complete?.();
    await running;
    assert.equal(hops.length, 1, 'later Austin→London→SF hops must not run');
  } finally {
    dom.restore();
  }
});

test('hashchange after boot still launches the traffic cinematic', async () => {
  const dom = mockDom();
  const enabled = [];
  const { viewer, hops } = mockViewer();
  const listeners = [];
  const windowRef = {
    location: { hash: '', search: '' },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
  };
  try {
    const { pack } = initShortsPack({
      viewer,
      windowRef,
      location: windowRef.location,
      dataManager: {
        async setEnabled(id) {
          enabled.push(id);
          return true;
        },
      },
    });
    assert.equal(pack, null);
    assert.equal(hops.length, 0);
    const hashListener = listeners.find((entry) => entry.type === 'hashchange');
    assert.ok(hashListener);
    windowRef.location.hash = '#shorts=traffic';
    await hashListener.handler();
    assert.deepEqual(enabled, ['traffic', 'cctv']);
    assert.equal(hops.length, 3);
  } finally {
    dom.restore();
  }
});

test('typhoon pack enables weather layers and hops W. Pacific → Japan', async () => {
  const dom = mockDom();
  const enabled = [];
  const { viewer, hops } = mockViewer();
  try {
    const pack = await runShortsPack({
      pack: 'typhoon',
      viewer,
      dataManager: {
        async setEnabled(id, on, options) {
          enabled.push({ id, on, origin: options?.origin });
          return true;
        },
      },
    });
    assert.equal(pack, 'typhoon');
    assert.deepEqual(enabled, [
      { id: 'weather', on: true, origin: 'programmatic' },
      { id: 'weather-effects', on: true, origin: 'programmatic' },
    ]);
    assert.equal(hops.length, 2);
    const [wpac, japan] = hops.map((hop) =>
      Cesium.Cartographic.fromCartesian(hop.destination),
    );
    assert.ok(Math.abs(Cesium.Math.toDegrees(wpac.longitude) - 138.5) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(wpac.latitude) - 24.2) < 0.001);
    assert.ok(Math.abs(wpac.height - 3_800_000) < 1);
    assert.ok(Math.abs(Cesium.Math.toDegrees(japan.longitude) - 135.5) < 0.001);
    assert.ok(Math.abs(Cesium.Math.toDegrees(japan.latitude) - 34.4) < 0.001);
    assert.match(dom.toast.textContent, /Typhoon Dujuan/);
    assert.match(dom.badge.textContent, /2026-09-22-typhoon/);
  } finally {
    dom.restore();
  }
});
