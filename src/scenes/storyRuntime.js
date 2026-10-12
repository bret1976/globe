/**
 * Presents a shot's story during playback: caption lower-third, a geolocated
 * media pin with a card, a dated before/after imagery swipe and spoken
 * narration. Everything it creates is released on end(), Stop and teardown,
 * so a story never outlives its shot (important for iPhone memory).
 */
import * as Cesium from 'cesium';
import {
  imageryLabel,
  imageryTileTemplate,
  storyHasContent,
} from '../director/story.js';
import { resolveMediaSrc } from './storyMedia.js';

const NARRATION_GRACE_MS = 4000;

function el(tag, style = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text != null) node.textContent = text;
  return node;
}

function speechAvailable() {
  return (
    typeof globalThis.speechSynthesis?.speak === 'function' &&
    typeof globalThis.SpeechSynthesisUtterance === 'function'
  );
}

/** Unlock speech inside a user gesture (iOS Safari requires it). */
export function primeSpeech() {
  if (!speechAvailable()) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {
    /* speech is optional */
  }
}

export function createStoryRuntime(viewer) {
  let root = null;
  let active = null; // { shot, caption, media, compare, narration }
  let generation = 0;

  function ensureRoot() {
    if (root?.isConnected) return root;
    root = el('div', {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '104',
      overflow: 'hidden',
      font: '13px/1.4 "JetBrains Mono", ui-monospace, Menlo, monospace',
      color: '#e3faff',
    });
    root.id = 'story-overlay';
    root.setAttribute('aria-live', 'polite');
    document.body.append(root);
    return root;
  }

  function showCaption(caption) {
    if (!caption?.title?.trim() && !caption?.text?.trim()) return null;
    const top = caption.position === 'top';
    const box = el('div', {
      position: 'absolute',
      left: 'max(16px, 4vw)',
      maxWidth: 'min(640px, 86vw)',
      [top ? 'top' : 'bottom']: top ? 'max(70px, 9vh)' : 'max(56px, 10vh)',
      background: 'rgba(4,14,20,0.78)',
      borderLeft: '3px solid #ffb547',
      padding: '10px 14px',
      boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
      opacity: '0',
      transition: 'opacity 400ms ease',
    });
    box.dataset.storyCaption = '';
    if (caption.title?.trim())
      box.append(
        el(
          'div',
          {
            font: '600 18px/1.25 sans-serif',
            letterSpacing: '0.04em',
            color: '#fff',
          },
          caption.title,
        ),
      );
    if (caption.text?.trim())
      box.append(
        el(
          'div',
          {
            marginTop: '4px',
            font: '14px/1.45 sans-serif',
            color: '#cfeff7',
            whiteSpace: 'pre-wrap',
          },
          caption.text,
        ),
      );
    ensureRoot().append(box);
    requestAnimationFrame(() => (box.style.opacity = '1'));
    return { box, caption };
  }

  function groundPosition(lat, lon) {
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const height = viewer.scene?.globe?.getHeight?.(carto);
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      Number.isFinite(height) ? height : 0,
    );
  }

  function toWindow(position) {
    const transform =
      Cesium.SceneTransforms.worldToWindowCoordinates ||
      Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const point = transform?.(viewer.scene, position);
    if (!point) return null;
    // Hide pins on the far side of the globe.
    const camera = viewer.camera.positionWC;
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      camera,
    );
    if (!occluder.isPointVisible(position)) return null;
    const rect = viewer.scene.canvas.getBoundingClientRect();
    return {
      x:
        rect.left +
        point.x * (rect.width / viewer.scene.canvas.clientWidth || 1),
      y:
        rect.top +
        point.y * (rect.height / viewer.scene.canvas.clientHeight || 1),
    };
  }

  async function showMedia(media, mine) {
    if (!media) return null;
    const position = groundPosition(media.lat, media.lon);
    const entity = viewer.entities.add({
      position,
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#ffb547'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const card = el('div', {
      position: 'absolute',
      width: 'min(300px, 44vw)',
      background: 'rgba(4,14,20,0.88)',
      border: '1px solid #ffb547',
      padding: '6px',
      boxShadow: '0 6px 22px rgba(0,0,0,0.5)',
      opacity: '0',
      transition: 'opacity 300ms ease',
      left: '0',
      top: '0',
    });
    card.dataset.storyMedia = '';
    const line = el('div', {
      position: 'absolute',
      height: '1px',
      background: '#ffb547',
      transformOrigin: '0 0',
      left: '0',
      top: '0',
    });
    const label = media.label?.trim()
      ? el(
          'div',
          {
            font: '11px/1.3 ui-monospace, monospace',
            color: '#ffd59a',
            marginTop: '4px',
          },
          `${media.label} · ${media.lat.toFixed(4)}, ${media.lon.toFixed(4)}`,
        )
      : el(
          'div',
          {
            font: '11px/1.3 ui-monospace, monospace',
            color: '#ffd59a',
            marginTop: '4px',
          },
          `${media.lat.toFixed(4)}, ${media.lon.toFixed(4)}`,
        );
    let node;
    let drawable = false;
    const state = {
      entity,
      card,
      line,
      node: null,
      drawable: false,
      position,
      anchor: null,
      cardRect: null,
      label: label.textContent,
    };
    try {
      const src = await resolveMediaSrc(media.src);
      if (mine !== generation) return state;
      const crossOrigin =
        /^https:/.test(src) && !src.startsWith(location.origin);
      if (media.kind === 'video') {
        node = el('video', {
          width: '100%',
          display: 'block',
          maxHeight: '40vh',
          background: '#000',
        });
        node.muted = true;
        node.playsInline = true;
        node.setAttribute('playsinline', '');
        node.loop = true;
        node.preload = 'auto';
        if (crossOrigin) node.crossOrigin = 'anonymous';
        node.src = src;
        node.play?.().catch(() => {});
      } else {
        node = el('img', {
          width: '100%',
          display: 'block',
          maxHeight: '40vh',
          objectFit: 'contain',
        });
        node.alt = media.label || 'Story media';
        if (crossOrigin) node.crossOrigin = 'anonymous';
        node.src = src;
      }
      // A cross-origin source without CORS still shows here, but cannot be
      // drawn into a recording; retry without CORS so it is at least visible.
      drawable = true;
      node.addEventListener('error', () => {
        if (node.crossOrigin && !node.dataset.retried) {
          node.dataset.retried = '1';
          state.drawable = false;
          node.removeAttribute('crossorigin');
          node.src = src;
        }
      });
    } catch (error) {
      node = el(
        'div',
        { padding: '12px', color: '#ffb547' },
        error.message || 'Media unavailable',
      );
    }
    state.node = node;
    state.drawable = drawable;
    card.append(node, label);
    ensureRoot().append(line, card);
    requestAnimationFrame(() => (card.style.opacity = '1'));
    return state;
  }

  function layoutMedia(media) {
    if (!media?.card) return;
    const anchor = toWindow(media.position);
    media.anchor = anchor;
    const w = innerWidth,
      h = innerHeight;
    const cw = media.card.offsetWidth || 300,
      ch = media.card.offsetHeight || 200;
    let x, y;
    if (anchor) {
      x = anchor.x + 40;
      y = anchor.y - ch - 40;
      if (x + cw > w - 12) x = anchor.x - cw - 40;
      if (y < 12) y = anchor.y + 40;
    } else {
      x = w - cw - 16;
      y = 80;
    }
    x = Math.max(12, Math.min(w - cw - 12, x));
    y = Math.max(12, Math.min(h - ch - 12, y));
    media.card.style.transform = `translate(${x}px, ${y}px)`;
    media.cardRect = { x, y, w: cw, h: ch };
    if (anchor) {
      const tx = x + (anchor.x < x ? 0 : cw),
        ty = y + (anchor.y < y ? 0 : ch);
      const dx = tx - anchor.x,
        dy = ty - anchor.y;
      media.line.style.display = 'block';
      media.line.style.width = `${Math.hypot(dx, dy)}px`;
      media.line.style.transform = `translate(${anchor.x}px, ${anchor.y}px) rotate(${Math.atan2(dy, dx)}rad)`;
    } else media.line.style.display = 'none';
  }

  function showCompare(compare, durationSec) {
    if (!compare) return null;
    const layers = viewer.imageryLayers;
    const make = (side) =>
      layers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: imageryTileTemplate(side),
          maximumLevel: 19,
          credit:
            side.source === 'wayback'
              ? 'Esri World Imagery Wayback'
              : 'Esri World Imagery',
        }),
      );
    const before = make(compare.before);
    const after = make(compare.after);
    before.splitDirection = Cesium.SplitDirection.LEFT;
    after.splitDirection = Cesium.SplitDirection.RIGHT;
    const previousSplit = viewer.scene.splitPosition;
    const state = {
      before,
      after,
      previousSplit,
      split: compare.split ?? 0.5,
      sweep: compare.sweep !== false,
      started: performance.now(),
      durationMs: Math.max(1500, durationSec * 1000),
      dragging: false,
      labels: [imageryLabel(compare.before), imageryLabel(compare.after)],
    };
    const divider = el('div', {
      position: 'absolute',
      top: '0',
      bottom: '0',
      width: '2px',
      marginLeft: '-1px',
      background: '#ffffff',
      boxShadow: '0 0 6px rgba(0,0,0,0.8)',
    });
    const handle = el(
      'div',
      {
        position: 'absolute',
        top: '50%',
        width: '34px',
        height: '34px',
        margin: '-17px 0 0 -17px',
        borderRadius: '50%',
        background: 'rgba(4,14,20,0.85)',
        border: '2px solid #fff',
        pointerEvents: 'auto',
        cursor: 'ew-resize',
        touchAction: 'none',
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        font: '14px sans-serif',
      },
      '⇔',
    );
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Before and after swipe');
    const tag = (text, side) =>
      el(
        'div',
        {
          position: 'absolute',
          top: 'max(64px, 8vh)',
          [side]: '0',
          padding: '4px 8px',
          background: 'rgba(4,14,20,0.8)',
          font: '600 11px/1.3 ui-monospace, monospace',
          letterSpacing: '0.06em',
          whiteSpace: 'nowrap',
        },
        text,
      );
    const leftTag = tag(`BEFORE · ${state.labels[0]}`, 'right');
    const rightTag = tag(`AFTER · ${state.labels[1]}`, 'left');
    leftTag.style.marginRight = '8px';
    rightTag.style.marginLeft = '8px';
    divider.append(handle, leftTag, rightTag);
    divider.dataset.storyCompare = '';
    ensureRoot().append(divider);
    const move = (event) => {
      if (!state.dragging) return;
      state.split = Math.max(0.02, Math.min(0.98, event.clientX / innerWidth));
      state.sweep = false;
    };
    const up = () => (state.dragging = false);
    handle.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      state.dragging = true;
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    state.divider = divider;
    return state;
  }

  function tickCompare(compare) {
    if (!compare) return;
    if (compare.sweep && !compare.dragging) {
      const t = Math.min(
        1,
        (performance.now() - compare.started) / compare.durationMs,
      );
      // Start mostly "before", reveal "after" across the shot.
      compare.split = 0.85 - 0.7 * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
    viewer.scene.splitPosition = compare.split;
    compare.divider.style.left = `${compare.split * 100}%`;
  }

  function speak(narration, mine) {
    if (!narration?.text?.trim()) return Promise.resolve();
    if (!speechAvailable()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const words = narration.text.trim().split(/\s+/).length;
      const rate = Number(narration.rate) || 1;
      const timer = setTimeout(
        done,
        (words / 2.2 / rate) * 1000 + NARRATION_GRACE_MS,
      );
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(narration.text);
        u.rate = rate;
        if (narration.voice) {
          const voice = speechSynthesis
            .getVoices()
            .find((v) => v.name === narration.voice);
          if (voice) u.voice = voice;
        }
        u.onend = done;
        u.onerror = done;
        if (mine !== generation) return done();
        speechSynthesis.speak(u);
      } catch {
        done();
      }
    });
  }

  let raf = 0;
  function loop() {
    raf = 0;
    if (!active) return;
    layoutMedia(active.media);
    tickCompare(active.compare);
    raf = requestAnimationFrame(loop);
  }

  function release(state) {
    if (!state) return;
    state.caption?.box.remove();
    if (state.media) {
      viewer.entities.remove(state.media.entity);
      state.media.card.remove();
      state.media.line.remove();
      const node = state.media.node;
      if (node?.tagName === 'VIDEO') {
        node.pause();
        node.removeAttribute('src');
        node.load();
      }
    }
    if (state.compare) {
      viewer.imageryLayers.remove(state.compare.before, true);
      viewer.imageryLayers.remove(state.compare.after, true);
      viewer.scene.splitPosition = state.compare.previousSplit ?? 0.5;
      state.compare.divider.remove();
    }
    viewer.scene.requestRender?.();
  }

  return {
    /** Present a shot's story; returns immediately. */
    begin(shot, durationSec = 4) {
      this.end();
      if (!storyHasContent(shot?.story)) return;
      const mine = ++generation;
      const story = shot.story;
      const state = {
        shot,
        caption: showCaption(story.caption),
        media: null,
        compare: showCompare(story.compare, durationSec),
      };
      state.narration = speak(story.narration, mine);
      active = state;
      showMedia(story.media, mine).then((media) => {
        if (active === state) state.media = media;
        else if (media) release({ media });
      });
      if (!raf) raf = requestAnimationFrame(loop);
    },
    /** Resolves when the current shot's narration has finished (bounded). */
    narrationDone(token) {
      const pending = active?.narration;
      if (!pending) return Promise.resolve();
      return new Promise((resolve) => {
        pending.then(resolve);
        token?.signal?.addEventListener?.('abort', resolve, { once: true });
      });
    },
    end() {
      generation++;
      if (speechAvailable() && active?.narration) speechSynthesis.cancel();
      const state = active;
      active = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      release(state);
    },
    /** Snapshot for the recorder's compositor (screen coordinates). */
    snapshot() {
      if (!active) return null;
      return {
        caption: active.caption
          ? {
              ...active.caption.caption,
              rect: active.caption.box.getBoundingClientRect(),
            }
          : null,
        media: active.media
          ? {
              node: active.media.node,
              drawable: active.media.drawable,
              anchor: active.media.anchor,
              rect: active.media.cardRect,
              label: active.media.label,
            }
          : null,
        compare: active.compare
          ? { split: active.compare.split, labels: active.compare.labels }
          : null,
      };
    },
    getState: () => ({
      active: !!active,
      shotId: active?.shot?.id || null,
      caption: !!active?.caption,
      media: !!active?.media,
      compare: !!active?.compare,
      narrating: !!active?.narration,
    }),
    destroy() {
      this.end();
      root?.remove();
      root = null;
    },
  };
}
