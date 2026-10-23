#!/usr/bin/env node
/**
 * Live/local QA for Street Photos (Panoramax) + satellite TLE freshness.
 * Usage: node scripts/qa-street-photos.mjs --url https://… --shots dir
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { propagate } from 'satellite.js';
import {
  parseOrbitalElements,
  satrecFromElements,
} from '../src/sources/orbitalElements.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = arg('url', 'http://localhost:4173');
const SHOTS = arg('shots', 'qa-shots/street-photos');
await fs.mkdir(SHOTS, { recursive: true });
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Satellites: TLE freshness from the deployed proxy -------------------
for (const group of ['stations', 'visual']) {
  const res = await fetch(`${BASE}/api/celestrak/${group}`);
  const body = await res.text();
  const [entry] = parseOrbitalElements(body);
  const rec = satrecFromElements(entry);
  // Element-set epoch (Julian date) from OMM or TLE alike.
  const epoch = (rec.jdsatepoch - 2440587.5) * 86400000;
  const ageDays = (Date.now() - epoch) / 86400000;
  check(
    `TLE ${group} epoch recent`,
    ageDays < 4,
    `age ${ageDays.toFixed(2)} d, cache ${res.headers.get('x-tle-cache')}, source ${res.headers.get('x-tle-source')}`,
  );
  const a = propagate(rec, new Date()).position;
  const b = propagate(rec, new Date(Date.now() + 10_000)).position;
  const moved = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  check(
    `TLE ${group} first sat moves`,
    moved > 1,
    `${moved.toFixed(1)} km in 10 s`,
  );
}

const browser = await puppeteer.launch({
  headless: arg('headless', 'new') === 'false' ? false : 'new',
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});

async function run(label, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on(
    'console',
    (m) => m.type() === 'error' && consoleErrors.push(m.text()),
  );
  // Skip the first-run mission card (per-session dismissal, as a visitor's close).
  await page.evaluateOnNewDocument(() => {
    try {
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
    } catch {}
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.layers?.get?.('street-photos'),
    { timeout: 90_000 },
  );
  await sleep(4000);
  // Close the first-run mission card the way a visitor would (Esc).
  await page.keyboard.press('Escape');
  await sleep(800);
  const shot = (n) =>
    page.screenshot({ path: path.join(SHOTS, `${label}-${n}.png`) });

  // Existing layers + satellites.
  await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    for (const id of ['satellites', 'earthquakes', 'flights'])
      if (dm.layers.get(id)) dm.setEnabled(id, true);
  });
  await sleep(15_000);
  const stats = await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    return Object.fromEntries(
      ['satellites', 'earthquakes', 'flights'].map((id) => [
        id,
        dm.layers.get(id)?.module?.getStats?.() || null,
      ]),
    );
  });
  for (const [id, s] of Object.entries(stats))
    check(
      `${label}: ${id} layer has data`,
      (s?.count || 0) > 0,
      JSON.stringify({
        count: s?.count,
        status: s?.status,
        err: s?.error || s?.lastError || null,
      }),
    );
  await shot('1-globe-layers');
  await page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    for (const id of ['earthquakes', 'flights']) dm.setEnabled(id, false);
  });

  // Street Photos over central Paris.
  await page.evaluate(() => {
    const gev = window.__godsEyeView;
    gev.dataManager.setEnabled('street-photos', true);
    const v = gev.viewer;
    const C3 = v.camera.positionWC.constructor;
    v.camera.cancelFlight();
    v.camera.setView({
      destination: C3.fromDegrees(2.3376, 48.8606, 1200),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await page
    .waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('street-photos')
          .module.getStats().count || 0) > 0,
      { timeout: 45_000 },
    )
    .catch(() => {});
  await sleep(2500);
  const sp = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('street-photos')
      .module.getStats(),
  );
  check(`${label}: Panoramax dots in Paris`, sp.count > 0, JSON.stringify(sp));
  await shot('2-panoramax-dots');

  // Click a dot on screen.
  const candidates = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer;
    const prims = v.scene.primitives;
    const found = [];
    for (let i = 0; i < prims.length; i++) {
      const c = prims.get(i);
      if (!c || typeof c.get !== 'function' || !c.length) continue;
      for (let j = 0; j < c.length; j++) {
        const p = c.get(j);
        if (typeof p?.id === 'string' && p.id.startsWith('pnx:img:')) {
          const w = v.scene.cartesianToCanvasCoordinates(p.position);
          const r = v.scene.canvas.getBoundingClientRect();
          const hitEl =
            w && document.elementFromPoint(r.left + w.x, r.top + w.y);
          if (
            hitEl?.tagName === 'CANVAS' &&
            w &&
            w.x > 60 &&
            w.y > 60 &&
            w.x < r.width - 60 &&
            w.y < r.height - 300
          )
            found.push({ x: r.left + w.x, y: r.top + w.y, id: p.id });
        }
      }
    }
    return found;
  });
  // Prefer a picture inside a multi-picture sequence (so ‹ › can be tested).
  let target = candidates[0] || null;
  for (const c of candidates.slice(0, 12)) {
    const id = c.id.slice('pnx:img:'.length);
    const r = await fetch(
      `https://api.panoramax.xyz/api/search?ids=${id}&limit=1`,
    )
      .then((x) => x.json())
      .catch(() => null);
    const rels = r?.features?.[0]?.links?.map((l) => l.rel) || [];
    if (rels.includes('next') || rels.includes('prev')) {
      target = c;
      break;
    }
  }
  check(`${label}: found an on-screen dot`, !!target, target?.id || '');
  if (target) {
    await page.mouse.click(target.x, target.y);
    await page
      .waitForFunction(
        () => {
          const img = document.querySelector(
            '#street-photo-viewer:not([hidden]) .street-photo-img',
          );
          return img && img.complete && img.naturalWidth > 0;
        },
        { timeout: 30_000 },
      )
      .catch(() => {});
    const view = await page.evaluate(() => {
      const root = document.querySelector('#street-photo-viewer');
      const img = root?.querySelector('.street-photo-img');
      return (
        root && {
          open: !root.hidden,
          w: img?.naturalWidth || 0,
          credit: root.querySelector('.street-photo-credit')?.textContent,
          license: root.querySelector('.street-photo-license')?.textContent,
          rect: root.getBoundingClientRect().toJSON(),
        }
      );
    });
    check(
      `${label}: photo opens and loads`,
      view?.open && view.w > 0,
      JSON.stringify(view),
    );
    const fits =
      view &&
      view.rect.left >= 0 &&
      view.rect.right <= viewport.width + 1 &&
      view.rect.bottom <= viewport.height + 1;
    check(`${label}: viewer fits the viewport`, !!fits);
    await shot('3-panoramax-photo');
    if (!view?.open) {
      await page.close();
      return;
    }
    const stepSel = await page.evaluate(() =>
      ['.street-photo-step.next', '.street-photo-step.prev'].find(
        (sel) => !document.querySelector(sel)?.disabled,
      ),
    );
    check(`${label}: photo has a sequence neighbour`, !!stepSel);
    if (stepSel) {
      const before = await page.evaluate(
        () => document.querySelector('.street-photo-img').src,
      );
      await page.click(stepSel);
      await page
        .waitForFunction(
          (b) => document.querySelector('.street-photo-img').src !== b,
          { timeout: 30_000 },
          before,
        )
        .catch(() => {});
      const after = await page.evaluate(
        () => document.querySelector('.street-photo-img').src,
      );
      check(`${label}: ‹ › steps along the sequence`, after !== before);
      await sleep(2500);
      await shot('4-panoramax-step');
    }
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(
      () => document.querySelector('#street-photo-viewer').hidden,
    );
    check(`${label}: Esc closes the viewer`, closed);
  }
  const relevant = [...pageErrors, ...consoleErrors].filter(
    (t) => !/favicon|ERR_BLOCKED_BY_CLIENT/i.test(t),
  );
  check(
    `${label}: no page errors`,
    pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '),
  );
  console.log(
    `  console errors (${relevant.length}): ${relevant.slice(0, 5).join(' | ').slice(0, 600)}`,
  );
  await page.close();
}

await run('desktop', { width: 1440, height: 900 });
await run('phone', {
  width: 390,
  height: 844,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
