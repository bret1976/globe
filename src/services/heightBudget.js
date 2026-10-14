/**
 * Time-budgeted, cached wrapper around Cesium's synchronous `scene.sampleHeight`.
 *
 * `sampleHeight` renders a pick pass against the photoreal mesh and reads it
 * back on the main thread. Calling it once per road / feature in a loop froze
 * the page for minutes when a layer loaded thousands of items. This keeps the
 * total spent per frame under a small budget and answers repeat lookups from
 * a coarse grid cache; callers fall back to their own default when it returns
 * `undefined`.
 */
const FRAME_BUDGET_MS = 4;
const CELL_DEG = 0.002; // ~200 m
const CACHE_MAX = 4096;
const CACHE_TTL_MS = 120_000;

const now = () =>
  globalThis.performance?.now ? globalThis.performance.now() : Date.now();

const cache = new Map();
let windowStart = -Infinity;
let spentMs = 0;
let lastFrame = -1;

function cellKey(carto) {
  const deg = 180 / Math.PI;
  const lat = Math.round((carto.latitude * deg) / CELL_DEG);
  const lon = Math.round((carto.longitude * deg) / CELL_DEG);
  return `${lat}:${lon}`;
}

function budgetOpen(scene, budgetMs) {
  const frame = scene?.frameState?.frameNumber;
  const t = now();
  // New frame (or, when frameNumber is unavailable, a new 16 ms window).
  if ((Number.isFinite(frame) && frame !== lastFrame) || t - windowStart > 16) {
    lastFrame = Number.isFinite(frame) ? frame : lastFrame;
    windowStart = t;
    spentMs = 0;
  }
  return spentMs < budgetMs;
}

/** True when this frame's sampling budget is already spent. */
export function heightBudgetSpent(scene, budgetMs = FRAME_BUDGET_MS) {
  return !budgetOpen(scene, budgetMs);
}

/** Cached cell height (no sampling), or undefined. */
export function cachedHeight(carto) {
  if (!carto) return undefined;
  const hit = cache.get(cellKey(carto));
  if (!hit) return undefined;
  if (now() - hit.at > CACHE_TTL_MS) return undefined;
  return hit.h;
}

/**
 * @returns {number|undefined} height in metres, or undefined when the budget
 * is spent, sampling is unsupported, or the mesh had no answer.
 */
export function sampleHeightBudgeted(
  scene,
  carto,
  excluded,
  { budgetMs = FRAME_BUDGET_MS, useCache = true } = {},
) {
  if (!scene || !carto) return undefined;
  if (useCache) {
    const c = cachedHeight(carto);
    if (c !== undefined) return c;
  }
  if (!scene.sampleHeightSupported) return undefined;
  if (!budgetOpen(scene, budgetMs)) return undefined;
  const t0 = now();
  let h;
  try {
    h = excluded
      ? scene.sampleHeight(carto, excluded)
      : scene.sampleHeight(carto);
  } catch {
    h = undefined;
  }
  spentMs += now() - t0;
  if (!Number.isFinite(h)) return undefined;
  if (useCache) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cellKey(carto), { h, at: now() });
  }
  return h;
}

/** Test hook. */
export function _resetHeightBudget() {
  cache.clear();
  windowStart = -Infinity;
  spentMs = 0;
  lastFrame = -1;
}
