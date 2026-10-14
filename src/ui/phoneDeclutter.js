/**
 * Phone-only HUD declutter. Desktop never runs any of this: everything is
 * gated on isPhoneLite() (the same detection PR #40's phone lite mode uses).
 *
 * - Marks <html> with `gev-phone-lite` so phone-only CSS can scope itself.
 * - Status notices (toast, global loading/acquiring chip, traffic + CCTV sync
 *   chips) never stack: only the most recently shown one stays visible.
 */
import { isPhoneLite } from '../app/phoneLite.js';

export const PHONE_LITE_ROOT_CLASS = 'gev-phone-lite';
const SUPPRESSED = 'phone-toast-suppressed';
const NOTICE_IDS = [
  'toast',
  'global-loading-status',
  'traffic-sync-chip',
  'cctv-sync-chip',
];

function noticeShown(el) {
  if (!el || el.hidden) return false;
  if (el.id === 'global-loading-status') return true;
  return el.classList.contains('visible');
}

let installed = null;

/** Idempotent; returns a disposer (no-op on desktop). */
export function installPhoneDeclutter({
  documentRef = globalThis.document,
  detect = isPhoneLite,
} = {}) {
  if (installed) return installed;
  if (!documentRef || !detect()) return () => {};
  documentRef.documentElement.classList.add(PHONE_LITE_ROOT_CLASS);
  const shownAt = new Map();
  let seq = 0;
  const sync = () => {
    let newest = null;
    for (const id of NOTICE_IDS) {
      const el = documentRef.getElementById(id);
      if (!el) continue;
      const shown = noticeShown(el);
      if (shown && !shownAt.has(id)) shownAt.set(id, ++seq);
      if (!shown) shownAt.delete(id);
      if (shown && (!newest || shownAt.get(id) > shownAt.get(newest.id)))
        newest = el;
    }
    for (const id of NOTICE_IDS) {
      const el = documentRef.getElementById(id);
      if (!el) continue;
      const suppress = shownAt.has(id) && el !== newest;
      if (el.classList.contains(SUPPRESSED) !== suppress)
        el.classList.toggle(SUPPRESSED, suppress);
    }
  };
  const observer = new MutationObserver(sync);
  const observeAll = () => {
    for (const id of NOTICE_IDS) {
      const el = documentRef.getElementById(id);
      if (el && !el.dataset.phoneDeclutterObserved) {
        el.dataset.phoneDeclutterObserved = '1';
        observer.observe(el, {
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      }
    }
  };
  observeAll();
  sync();
  installed = () => {
    observer.disconnect();
    installed = null;
  };
  return installed;
}
