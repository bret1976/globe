/**
 * Phone-only screen-space clustering for dense billboard layers (CCTV, flights).
 *
 * Cesium's EntityCluster only works on DataSources; these layers draw straight
 * into BillboardCollections whose `show`/`color` the layers themselves rewrite
 * every tick. So this clusterer never touches layer-owned state between frames:
 * it hides cluster members only for the duration of a render (and a pick) and
 * restores them right after, drawing one cyan count badge per cluster instead.
 * Zooming in spreads the members apart on screen, so badges split naturally.
 * Nothing is dropped — every member is still in its layer and reappears as soon
 * as it has room. Desktop never constructs one of these (see isPhoneLite()).
 */
import * as Cesium from 'cesium';

const badgeCache = new Map();
function badgeImage(count, color) {
  const text = count > 999 ? '999+' : String(count);
  const key = `${text}|${color}`;
  const cached = badgeCache.get(key);
  if (cached) return cached;
  const ratio = 2;
  const size = text.length >= 3 ? 40 : 34;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(4, 16, 22, 0.82)';
  ctx.fill();
  ctx.lineWidth = 1.75;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = `600 ${text.length >= 4 ? 10 : 12}px 'JetBrains Mono', 'SF Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, r, r + 0.5);
  const entry = { canvas, size };
  badgeCache.set(key, entry);
  return entry;
}

/**
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer
 * @param {() => Iterable<{key: string, bb: Cesium.Billboard}>} options.items
 * @param {() => boolean} [options.isActive] Layer currently drawn.
 * @param {(key: string) => boolean} [options.isExcluded] Never cluster (tracked/selected).
 * @param {string} [options.color]
 * @param {number} [options.pixelRange]
 * @param {number} [options.minClusterSize]
 * @param {number} [options.recomputeMs]
 */
export function createPhoneBillboardClusterer({
  viewer,
  items,
  isActive = () => true,
  isExcluded = () => false,
  color = '#6be8ff',
  pixelRange = 52,
  minClusterSize = 3,
  recomputeMs = 400,
}) {
  const scene = viewer.scene;
  const badges = scene.primitives.add(new Cesium.BillboardCollection());
  let hidden = new Set();
  let clusters = [];
  let lastAt = 0;
  let destroyed = false;
  const prevShow = new Map();
  const scratch = new Cesium.Cartesian2();

  function recompute() {
    lastAt = performance.now();
    hidden = new Set();
    clusters = [];
    if (!isActive()) {
      badges.removeAll();
      return;
    }
    const canvas = scene.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const cells = new Map();
    for (const { key, bb } of items()) {
      if (!bb || !bb.show || !bb.position || isExcluded(key)) continue;
      const p = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        bb.position,
        scratch,
      );
      if (
        !p ||
        p.x < -pixelRange ||
        p.y < -pixelRange ||
        p.x > w + pixelRange ||
        p.y > h + pixelRange
      )
        continue;
      const cell = `${Math.floor(p.x / pixelRange)}:${Math.floor(p.y / pixelRange)}`;
      let c = cells.get(cell);
      if (!c) cells.set(cell, (c = { members: [], sx: 0, sy: 0, sz: 0 }));
      c.members.push(bb);
      c.sx += bb.position.x;
      c.sy += bb.position.y;
      c.sz += bb.position.z;
    }
    for (const c of cells.values()) {
      if (c.members.length < minClusterSize) continue;
      const n = c.members.length;
      for (const bb of c.members) hidden.add(bb);
      clusters.push({
        count: n,
        position: new Cesium.Cartesian3(c.sx / n, c.sy / n, c.sz / n),
      });
    }
    badges.removeAll();
    for (const cluster of clusters) {
      const { canvas: image, size } = badgeImage(cluster.count, color);
      cluster.badge = badges.add({
        position: cluster.position,
        image,
        width: size,
        height: size,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { gevPhoneCluster: true, count: cluster.count },
      });
    }
  }

  function hideMembers() {
    prevShow.clear();
    for (const bb of hidden) {
      prevShow.set(bb, bb.show);
      if (bb.show) bb.show = false;
    }
  }
  function restoreMembers() {
    for (const [bb, show] of prevShow) {
      try {
        if (bb.show !== show) bb.show = show;
      } catch {
        /* billboard removed mid-frame */
      }
    }
    prevShow.clear();
  }

  // Run LAST in preRender so layer passes that rewrite `show` cannot undo the
  // hide: re-append the listener after each frame.
  let removePre = null;
  const onPre = () => {
    if (destroyed) return;
    if (performance.now() - lastAt > recomputeMs) recompute();
    hideMembers();
  };
  const onPost = () => {
    if (destroyed) return;
    restoreMembers();
    removePre?.();
    removePre = scene.preRender.addEventListener(onPre);
  };
  removePre = scene.preRender.addEventListener(onPre);
  const removePost = scene.postRender.addEventListener(onPost);

  // Picks do not raise preRender: hide members there too so a tap on a badge
  // lands on the badge, not on an icon buried under it.
  const basePick = scene.pick;
  const wrappedPick = function (...args) {
    if (destroyed || !hidden.size) return basePick.apply(this, args);
    hideMembers();
    try {
      return basePick.apply(this, args);
    } finally {
      restoreMembers();
    }
  };
  scene.pick = wrappedPick;

  // Tap a badge → zoom toward it so it splits.
  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (destroyed || !clusters.length) return;
    let best = null;
    let bestD = 30;
    for (const c of clusters) {
      const p = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        c.position,
        scratch,
      );
      if (!p) continue;
      const d = Math.hypot(p.x - click.position.x, p.y - click.position.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return;
    const carto = Cesium.Cartographic.fromCartesian(best.position);
    const camHeight = viewer.camera.positionCartographic.height;
    const range = Math.max(400, (camHeight - (carto.height || 0)) / 3);
    viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(best.position, 1),
      {
        offset: new Cesium.HeadingPitchRange(
          viewer.camera.heading,
          viewer.camera.pitch,
          range,
        ),
        duration: 0.8,
      },
    );
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    isHidden: (bb) => hidden.has(bb),
    get clusterCount() {
      return clusters.length;
    },
    get hiddenCount() {
      return hidden.size;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      restoreMembers();
      removePre?.();
      removePost();
      if (scene.pick === wrappedPick) scene.pick = basePick;
      handler.destroy();
      if (!scene.isDestroyed?.()) scene.primitives.remove(badges);
      hidden = new Set();
      clusters = [];
    },
  };
}

/** Indices of the `max` nearest points to `origin` (squared distance). */
export function nearestKeys(entries, origin, max) {
  if (entries.length <= max) return new Set(entries.map((e) => e.key));
  const scored = entries.map((e) => ({
    key: e.key,
    d: Cesium.Cartesian3.distanceSquared(e.position, origin),
  }));
  scored.sort((a, b) => a.d - b.d);
  return new Set(scored.slice(0, max).map((s) => s.key));
}
