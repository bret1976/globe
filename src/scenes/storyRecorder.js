/**
 * One-click recording of a scene run. The Cesium canvas and the story
 * overlays (caption, media card, swipe divider) are composited into one
 * 2D canvas right after each render and captured with MediaRecorder.
 * MP4 is used where the browser can encode it (Safari, recent Chrome),
 * WebM otherwise. Spoken narration is browser speech and is not captured.
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickRecordingMime() {
  const MR = globalThis.MediaRecorder;
  if (!MR) return null;
  return MIME_CANDIDATES.find((type) => MR.isTypeSupported?.(type)) || '';
}

export function recordingSupported() {
  return (
    typeof globalThis.MediaRecorder === 'function' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  );
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function drawOverlays(ctx, snap, map, scale) {
  if (!snap) return;
  const { compare, media, caption } = snap;
  if (compare) {
    const x = compare.split * ctx.canvas.width;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 1 * scale, 0, 2 * scale, ctx.canvas.height);
    ctx.font = `600 ${11 * scale}px monospace`;
    const pad = 6 * scale,
      y = 64 * scale;
    const left = `BEFORE · ${compare.labels[0]}`,
      right = `AFTER · ${compare.labels[1]}`;
    const lw = ctx.measureText(left).width,
      rw = ctx.measureText(right).width;
    ctx.fillStyle = 'rgba(4,14,20,0.8)';
    ctx.fillRect(x - lw - 3 * pad, y, lw + 2 * pad, 20 * scale);
    ctx.fillRect(x + pad, y, rw + 2 * pad, 20 * scale);
    ctx.fillStyle = '#e3faff';
    ctx.fillText(left, x - lw - 2 * pad, y + 14 * scale);
    ctx.fillText(right, x + 2 * pad, y + 14 * scale);
  }
  if (media?.rect) {
    const r = media.rect;
    const [x, y] = map(r.x, r.y);
    const w = r.w * scale,
      h = r.h * scale;
    if (media.anchor) {
      const [ax, ay] = map(media.anchor.x, media.anchor.y);
      ctx.strokeStyle = '#ffb547';
      ctx.lineWidth = Math.max(1, scale);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax < x ? x : x + w, ay < y ? y : y + h);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(4,14,20,0.88)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ffb547';
    ctx.strokeRect(x, y, w, h);
    const node = media.node;
    const ready =
      node &&
      (node.tagName === 'VIDEO'
        ? node.readyState >= 2
        : node.complete && node.naturalWidth);
    const pad = 6 * scale;
    const labelH = 18 * scale;
    if (ready && media.drawable) {
      const nw = node.videoWidth || node.naturalWidth,
        nh = node.videoHeight || node.naturalHeight;
      const bw = w - 2 * pad,
        bh = h - 2 * pad - labelH;
      const k = Math.min(bw / nw, bh / nh);
      try {
        ctx.drawImage(
          node,
          x + pad + (bw - nw * k) / 2,
          y + pad + (bh - nh * k) / 2,
          nw * k,
          nh * k,
        );
      } catch {
        /* tainted or not decodable */
      }
    }
    ctx.fillStyle = '#ffd59a';
    ctx.font = `${11 * scale}px monospace`;
    ctx.fillText(
      media.label || '',
      x + pad,
      y + h - pad - 2 * scale,
      w - 2 * pad,
    );
  }
  if (caption?.rect) {
    const r = caption.rect;
    const [x, y] = map(r.left, r.top);
    ctx.fillStyle = 'rgba(4,14,20,0.78)';
    ctx.fillRect(x, y, r.width * scale, r.height * scale);
    ctx.fillStyle = '#ffb547';
    ctx.fillRect(x, y, 3 * scale, r.height * scale);
    let cy = y + 10 * scale;
    const maxW = r.width * scale - 28 * scale;
    if (caption.title?.trim()) {
      ctx.font = `600 ${18 * scale}px sans-serif`;
      ctx.fillStyle = '#fff';
      for (const line of wrap(ctx, caption.title, maxW)) {
        cy += 18 * scale;
        ctx.fillText(line, x + 14 * scale, cy);
      }
      cy += 6 * scale;
    }
    if (caption.text?.trim()) {
      ctx.font = `${14 * scale}px sans-serif`;
      ctx.fillStyle = '#cfeff7';
      for (const line of wrap(ctx, caption.text, maxW)) {
        cy += 18 * scale;
        ctx.fillText(line, x + 14 * scale, cy);
      }
    }
  }
}

/**
 * Record while `run()` plays, then return { blob, type, url, fileName }.
 * @param {object} viewer Cesium viewer
 * @param {() => object|null} snapshot story overlay snapshot
 * @param {() => Promise<unknown>} run resolves when playback ends
 */
export async function recordRun(viewer, snapshot, run, { maxEdge } = {}) {
  if (!recordingSupported())
    throw new Error('Recording is not supported in this browser');
  const source = viewer.scene.canvas;
  const mobile = Math.min(innerWidth, innerHeight) < 600;
  const edge = maxEdge || (mobile ? 960 : 1280);
  const rect = () => source.getBoundingClientRect();
  const r0 = rect();
  const scale = Math.min(1, edge / Math.max(r0.width, r0.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round((r0.width * scale) / 2) * 2);
  canvas.height = Math.max(2, Math.round((r0.height * scale) / 2) * 2);
  const ctx = canvas.getContext('2d');
  const compose = () => {
    try {
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    const r = rect();
    const sx = canvas.width / r.width;
    drawOverlays(
      ctx,
      snapshot(),
      (x, y) => [(x - r.left) * sx, (y - r.top) * sx],
      sx,
    );
  };
  const removeRender = viewer.scene.postRender.addEventListener(compose);
  let pump = 0;
  const tick = () => {
    viewer.scene.requestRender?.();
    pump = requestAnimationFrame(tick);
  };
  tick();
  const type = pickRecordingMime();
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, {
    ...(type ? { mimeType: type } : {}),
    videoBitsPerSecond: mobile ? 2500000 : 5000000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) =>
    event.data?.size && chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  const started = performance.now();
  recorder.start(1000);
  let runResult;
  try {
    runResult = await run();
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    cancelAnimationFrame(pump);
    removeRender();
    stream.getTracks().forEach((track) => track.stop());
    canvas.width = canvas.height = 0;
  }
  const finalType = (recorder.mimeType || type || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type: finalType });
  const ext = finalType.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return {
    blob,
    type: finalType,
    url: URL.createObjectURL(blob),
    fileName: `godseye-story-${stamp}.${ext}`,
    durationMs: Math.round(performance.now() - started),
    width: Math.round(r0.width * scale),
    runResult,
  };
}
