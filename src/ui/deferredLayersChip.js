/**
 * Small "tap to resume" chip for saved layers that were held back from the
 * automatic restore (cap, crash recovery). Self-contained; no layout change
 * to the existing shell. Returns `{ remove }`.
 */
export function showDeferredLayersChip({
  layerIds,
  onResume,
  doc = globalThis.document,
  autoHideMs = 90_000,
} = {}) {
  if (!doc?.body || !Array.isArray(layerIds) || layerIds.length === 0)
    return { remove() {} };
  const chip = doc.createElement('div');
  chip.className = 'gev-deferred-layers';
  chip.setAttribute('role', 'status');
  chip.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:calc(88px + env(safe-area-inset-bottom, 0px))',
    'transform:translateX(-50%)',
    'z-index:9000',
    'display:flex',
    'gap:8px',
    'align-items:center',
    'padding:6px 8px 6px 12px',
    'border-radius:999px',
    'background:rgba(8,12,16,0.82)',
    'border:1px solid rgba(120,220,255,0.35)',
    'color:#cfefff',
    'font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
    'letter-spacing:0.04em',
    'backdrop-filter:blur(6px)',
    'pointer-events:auto',
  ].join(';');
  const label = doc.createElement('span');
  const n = layerIds.length;
  label.textContent = `${n} SAVED LAYER${n === 1 ? '' : 'S'} PAUSED`;
  const resume = doc.createElement('button');
  resume.type = 'button';
  resume.textContent = 'RESUME';
  resume.setAttribute('aria-label', `Resume ${n} saved layers`);
  const btnCss =
    'cursor:pointer;border-radius:999px;border:1px solid rgba(120,220,255,0.5);background:rgba(120,220,255,0.12);color:inherit;font:inherit;padding:4px 10px';
  resume.style.cssText = btnCss;
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = btnCss + ';padding:2px 8px';
  chip.append(label, resume, close);
  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    chip.remove();
  };
  resume.addEventListener('click', () => {
    remove();
    void onResume?.(layerIds.slice());
  });
  close.addEventListener('click', () => {
    remove();
    try {
      globalThis.localStorage?.removeItem('gev.deferredLayers.v1');
    } catch {
      /* best effort */
    }
  });
  doc.body.appendChild(chip);
  if (autoHideMs > 0) timer = setTimeout(remove, autoHideMs);
  return { remove };
}
