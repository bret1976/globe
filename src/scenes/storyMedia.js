/**
 * Local storage for story media uploads. Images are downscaled into small
 * inline data URLs so they live inside the scene document (and therefore in
 * export/import/share). Videos are too large for the scene document, so they
 * are kept in IndexedDB on this device and referenced as `upload:<id>`; a
 * story file (exportStoryFile/importStoryFile) carries them between devices.
 */
const DB_NAME = 'godsEyeView.storyMedia';
const STORE = 'media';
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const INLINE_LIMIT = 60000;

let dbPromise = null;
function db() {
  if (!globalThis.indexedDB)
    return Promise.reject(new Error('Upload storage unavailable'));
  dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Upload storage unavailable'));
    };
  });
  return dbPromise;
}
function tx(mode, run) {
  return db().then(
    (database) =>
      new Promise((resolve, reject) => {
        const t = database.transaction(STORE, mode);
        const request = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(request?.result);
        t.onerror = () => reject(t.error || new Error('Upload storage failed'));
        t.onabort = () => reject(t.error || new Error('aborted'));
      }),
  );
}

// Stored as bytes + type: some WebKit contexts refuse Blob values in IndexedDB.
export async function putUpload(id, blob) {
  const record = {
    type: blob.type || 'application/octet-stream',
    bytes: await blob.arrayBuffer(),
  };
  return tx('readwrite', (s) => s.put(record, id));
}
export async function getUpload(id) {
  const record = await tx('readonly', (s) => s.get(id));
  if (!record) return null;
  if (record instanceof Blob) return record;
  return new Blob([record.bytes], { type: record.type });
}

const urlCache = new Map();
/** Resolve a stored src to something an <img>/<video> can load. */
export async function resolveMediaSrc(src) {
  if (!src?.startsWith('upload:')) return src;
  const id = src.slice(7);
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getUpload(id).catch(() => null);
  if (!blob) throw new Error('Uploaded media is not on this device');
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be read'));
    img.src = url;
  });
}

/** Downscale an image file until its JPEG data URL fits the scene document. */
export async function imageFileToInline(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (const [edge, quality] of [
      [720, 0.72],
      [560, 0.66],
      [420, 0.6],
      [320, 0.55],
      [240, 0.5],
    ]) {
      const scale = Math.min(1, edge / Math.max(img.width, img.height));
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length <= INLINE_LIMIT) {
        canvas.width = canvas.height = 0;
        return data;
      }
    }
    throw new Error('Image is too detailed to store; try a smaller one');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Store a video file on this device and return its scene reference. */
export async function storeVideoFile(file) {
  if (file.size > MAX_VIDEO_BYTES)
    throw new Error('Video is larger than 25 MB; use a URL instead');
  const id = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await putUpload(id, file);
  return `upload:${id}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Collect `upload:` references used by a scene. */
export function uploadRefs(scene) {
  return [
    ...new Set(
      (scene?.shots || [])
        .map((shot) => shot.story?.media?.src)
        .filter((src) => src?.startsWith('upload:'))
        .map((src) => src.slice(7)),
    ),
  ];
}

/** A self-contained story file: the scene document plus uploaded videos. */
export async function buildStoryFile(sceneDocumentText, scene) {
  const media = {};
  for (const id of uploadRefs(scene)) {
    const blob = await getUpload(id).catch(() => null);
    if (blob)
      media[id] = {
        type: blob.type || 'video/mp4',
        data: await blobToBase64(blob),
      };
  }
  return JSON.stringify({
    format: 'godseye-story',
    version: 1,
    scene: JSON.parse(sceneDocumentText),
    media,
  });
}

/** Restore uploaded videos from a story file; returns the scene document text. */
export async function unpackStoryFile(text) {
  const parsed = JSON.parse(text);
  if (parsed?.format !== 'godseye-story' || !parsed.scene)
    throw new Error('Not a GodsEye story file');
  for (const [id, entry] of Object.entries(parsed.media || {})) {
    if (!/^[a-z0-9-]{4,64}$/.test(id) || typeof entry?.data !== 'string')
      continue;
    const bytes = Uint8Array.from(atob(entry.data), (c) => c.charCodeAt(0));
    await putUpload(
      id,
      new Blob([bytes], { type: String(entry.type || 'video/mp4') }),
    );
  }
  return JSON.stringify(parsed.scene);
}
