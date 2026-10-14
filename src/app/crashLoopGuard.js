/**
 * Crash-loop guard for constrained (phone) clients.
 *
 * iOS Safari kills the WebContent process when the page outgrows its memory
 * budget and, after a repeat, shows "A problem repeatedly occurred". A page
 * that died during boot leaves its boot marker behind (it never reached the
 * stable mark and never got a clean pagehide), so the next load knows to
 * bring the restored layers up more gently. Storage is best effort.
 */
export const BOOT_MARKER_KEY = 'gev.bootPending.v1';
/** A boot that survives this long counts as stable. */
export const BOOT_STABLE_MS = 45_000;
/** Ignore markers older than this (an old tab, not a crash loop). */
const MARKER_MAX_AGE_MS = 10 * 60_000;

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ recovering: boolean, markStable: () => void }}
 */
export function startBootCrashGuard({
  storage = safeLocalStorage(),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  win = globalThis.window,
} = {}) {
  let recovering = false;
  try {
    const prior = Number(storage?.getItem?.(BOOT_MARKER_KEY));
    recovering =
      Number.isFinite(prior) && prior > 0 && now() - prior < MARKER_MAX_AGE_MS;
    storage?.setItem?.(BOOT_MARKER_KEY, String(now()));
  } catch {
    /* storage unavailable: behave as a normal boot */
  }
  let done = false;
  const markStable = () => {
    if (done) return;
    done = true;
    try {
      storage?.removeItem?.(BOOT_MARKER_KEY);
    } catch {
      /* best effort */
    }
  };
  setTimer(markStable, BOOT_STABLE_MS);
  // A normal navigation or tab close is not a crash.
  try {
    win?.addEventListener?.('pagehide', markStable, { once: true });
  } catch {
    /* non-browser host */
  }
  return { recovering, markStable };
}

/**
 * Restore pacing for the layer-state coordinator. Every client now starts
 * enabled layers one at a time (desktop used to restore all of them in
 * parallel and could lock the main thread); phones space them further apart.
 */
export function layerRestorePacing({ constrained, recovering }) {
  if (!constrained) return { stepMs: 1_500, gapMs: 400 };
  // `enable()` usually resolves before the feed's download/parse/GPU upload
  // finishes, so the gap (not the settle wait) is what actually spaces the
  // heavy work out. 14 layers ≈ 17 s normally, ≈ 45 s after a crash.
  return recovering
    ? { stepMs: 6_000, gapMs: 3_000 }
    : { stepMs: 3_000, gapMs: 1_200 };
}

/** Saved layers beyond this many wait for a tap instead of auto-restoring. */
export const AUTO_RESTORE_LAYER_CAP = 5;
/** Layers held back from auto-restore, offered as "tap to resume". */
export const DEFERRED_LAYERS_KEY = 'gev.deferredLayers.v1';

/**
 * Decide what the saved local layer state may auto-restore this boot.
 * Pure: takes the raw stored string (`{ v, l, o }`) and returns the string to
 * store back plus the layer ids held for "tap to resume".
 *
 * - `safe` (?safe=1): drop saved layers entirely, nothing offered.
 * - `recovering` (previous boot died before it was stable): start with no
 *   layers and offer all of them.
 * - otherwise keep the first `cap` and offer the rest.
 *
 * @returns {{ raw: string|null, deferred: string[], changed: boolean }}
 */
export function planLocalLayerRestore({
  raw,
  recovering = false,
  safe = false,
  cap = AUTO_RESTORE_LAYER_CAP,
} = {}) {
  if (safe) return { raw: null, deferred: [], changed: raw != null };
  let parsed;
  try {
    parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.l))
    return { raw, deferred: [], changed: false };
  const ids = parsed.l.map(String);
  const keep = recovering ? [] : ids.slice(0, Math.max(0, cap));
  const deferred = ids.slice(keep.length);
  if (deferred.length === 0) return { raw, deferred: [], changed: false };
  return {
    raw: JSON.stringify({ ...parsed, l: keep }),
    deferred,
    changed: true,
  };
}

/** True when the page URL asks for a safe (no saved layers) boot. */
export function isSafeBootRequested(loc = globalThis.location) {
  try {
    const q = new URLSearchParams(loc?.search || '');
    const v = q.get('safe');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}
