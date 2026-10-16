import {
  GONE_MESSAGE,
  PANORAMAX_NAME,
  panoramaxPictureUrl,
} from './panoramax/policy.js';

/**
 * Caption pieces for one normalized Panoramax picture. Credits every
 * producer (never an email address) or, failing that, the instance holding
 * the picture, plus the picture's own licence, as Panoramax licences ask.
 */
export function photoCaption(pose) {
  if (!pose) return null;
  const date = Number.isFinite(pose.capturedAt)
    ? new Date(pose.capturedAt).toISOString().slice(0, 10)
    : null;
  const credit = pose.creator
    ? `© ${pose.creator}`
    : pose.via
      ? `via ${pose.via}`
      : `© ${PANORAMAX_NAME} contributors`;
  return {
    title: pose.isPano ? '360° PHOTO' : 'PHOTO',
    date,
    credit,
    license: pose.license || 'licence: see Panoramax',
    href: panoramaxPictureUrl(pose.id),
    image: pose.urls?.sd || pose.urls?.thumb || null,
    hasPrev: Boolean(pose.prevId),
    hasNext: Boolean(pose.nextId),
  };
}

/**
 * The Street Photos viewer: a glass card (right side on desktop, bottom
 * sheet on phones) showing one picture with caption, licence, a link to the
 * Panoramax viewer and ‹ › along the picture's sequence.
 */
export function createPhotoViewer({
  document = globalThis.document,
  onStep = () => {},
  onClose = () => {},
} = {}) {
  let root = null;
  let current = null;
  const els = {};

  function build() {
    root = document.createElement('section');
    root.id = 'street-photo-viewer';
    root.className = 'street-photo-viewer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Street-level photo');
    root.hidden = true;
    root.innerHTML = `
      <header class="street-photo-header">
        <span class="street-photo-title">STREET PHOTO · PANORAMAX</span>
        <button type="button" class="street-photo-close" aria-label="Close photo">×</button>
      </header>
      <div class="street-photo-frame">
        <img class="street-photo-img" alt="Street-level photo" decoding="async" referrerpolicy="no-referrer" />
        <span class="street-photo-badge" hidden>360°</span>
        <div class="street-photo-status" hidden></div>
        <button type="button" class="street-photo-step prev" aria-label="Previous photo">‹</button>
        <button type="button" class="street-photo-step next" aria-label="Next photo">›</button>
      </div>
      <footer class="street-photo-caption">
        <span class="street-photo-date"></span>
        <span class="street-photo-credit"></span>
        <span class="street-photo-license"></span>
        <a class="street-photo-link" target="_blank" rel="noopener">Open in Panoramax ↗</a>
      </footer>`;
    for (const [key, sel] of Object.entries({
      img: '.street-photo-img',
      badge: '.street-photo-badge',
      status: '.street-photo-status',
      prev: '.street-photo-step.prev',
      next: '.street-photo-step.next',
      date: '.street-photo-date',
      credit: '.street-photo-credit',
      license: '.street-photo-license',
      link: '.street-photo-link',
      close: '.street-photo-close',
      title: '.street-photo-title',
    }))
      els[key] = root.querySelector(sel);
    els.close.addEventListener('click', () => close());
    els.prev.addEventListener(
      'click',
      () => current?.prevId && onStep(current.prevId),
    );
    els.next.addEventListener(
      'click',
      () => current?.nextId && onStep(current.nextId),
    );
    els.img.addEventListener('error', () => setStatus(GONE_MESSAGE));
    els.img.addEventListener('load', () => setStatus(null));
    root.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(root);
  }

  function onKey(event) {
    if (!root || root.hidden || event.defaultPrevented) return;
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowLeft' && current?.prevId) {
      event.preventDefault();
      onStep(current.prevId);
    } else if (event.key === 'ArrowRight' && current?.nextId) {
      event.preventDefault();
      onStep(current.nextId);
    }
  }

  function setStatus(text) {
    if (!els.status) return;
    els.status.hidden = !text;
    els.status.textContent = text || '';
  }

  function show(pose) {
    if (!root) build();
    const caption = photoCaption(pose);
    if (!caption) return;
    current = pose;
    root.hidden = false;
    els.title.textContent = `STREET ${caption.title} · PANORAMAX`;
    els.badge.hidden = !pose.isPano;
    els.date.textContent = caption.date || '';
    els.credit.textContent = caption.credit;
    els.license.textContent = caption.license;
    els.link.href = caption.href;
    els.prev.disabled = !caption.hasPrev;
    els.next.disabled = !caption.hasNext;
    if (caption.image) {
      setStatus('loading…');
      els.img.src = caption.image;
    } else {
      els.img.removeAttribute('src');
      setStatus(GONE_MESSAGE);
    }
  }

  function showError(message) {
    if (!root) build();
    root.hidden = false;
    setStatus(message);
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    els.img.removeAttribute('src');
    current = null;
    onClose();
  }

  return {
    show,
    showError,
    close,
    get current() {
      return current;
    },
    get open() {
      return Boolean(root && !root.hidden);
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      root?.remove();
      root = null;
      current = null;
    },
  };
}
