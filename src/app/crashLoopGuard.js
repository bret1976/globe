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
 * Restore pacing for the layer-state coordinator. Desktop keeps the parallel
 * restore; phones start one enabled layer at a time, and a phone recovering
 * from a crash during the previous boot spaces them further apart.
 */
export function layerRestorePacing({ constrained, recovering }) {
  if (!constrained) return null;
  // `enable()` usually resolves before the feed's download/parse/GPU upload
  // finishes, so the gap (not the settle wait) is what actually spaces the
  // heavy work out. 14 layers ≈ 17 s normally, ≈ 45 s after a crash.
  return recovering
    ? { stepMs: 6_000, gapMs: 3_000 }
    : { stepMs: 3_000, gapMs: 1_200 };
}
