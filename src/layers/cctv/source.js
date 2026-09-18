import {
  ACTIVE_FRAME_REFRESH_MS,
  FRAME_ENDPOINT,
  MEDIA_ENDPOINT,
} from './sourcePolicy.js';

/** Catalog/health must fail cleanly so CCTV init cannot hang the HUD. */
export const CCTV_SOURCE_CLIENT_TIMEOUT_MS = 12_000;

function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const cadenceMs = Math.max(
    1000,
    safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
  );
  const tick = Math.floor(Date.now() / cadenceMs);
  const params = new URLSearchParams({
    label: camera.name,
    city: camera.city,
    lat: camera.lat.toFixed(6),
    lon: camera.lon.toFixed(6),
    heading: String(Math.round(camera.headingDeg)),
    fov: String(Math.round(camera.fovDeg)),
    pitch: String(Math.round(camera.pitchDeg || -10)),
    ts: String(tick),
  });
  return `${FRAME_ENDPOINT}/${encodeURIComponent(camera.id)}?${params.toString()}`;
}
function mediaUrlFor(camera) {
  return `${MEDIA_ENDPOINT}/${encodeURIComponent(camera.id)}?ts=${Math.floor(Date.now() / 15000)}`;
}
/** Supply catalog/health records and the existing registered camera URL families. */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = CCTV_SOURCE_CLIENT_TIMEOUT_MS,
  timeoutSignal = null,
} = {}) {
  async function read(path, key, { signal } = {}) {
    signal?.throwIfAborted();
    const timeout =
      timeoutSignal ||
      AbortSignal.timeout(
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : CCTV_SOURCE_CLIENT_TIMEOUT_MS,
      );
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(path, {
        cache: 'no-store',
        signal: combined,
      });
      if (!response.ok)
        throw new Error('Camera source HTTP ' + response.status);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.[key]))
        throw new Error('Malformed camera ' + key + ' snapshot');
      return payload;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new Error('Camera source timed out');
      throw error;
    }
  }
  return {
    getCatalog(options) {
      return read('/api/cctv/sources', 'sources', options);
    },
    getHealth(options) {
      return read('/api/cctv/health', 'cameras', options);
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
  };
}
