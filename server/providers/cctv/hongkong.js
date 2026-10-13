import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HONGKONG_CCTV_URL,
  HONGKONG_IMAGE_ORIGIN,
  DEFAULT_HONGKONG_MAX_SOURCES,
  HONGKONG_MAX_CATALOG_BYTES,
  HONGKONG_ANCHORS,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
  isPlausibleLatLon,
  cameraDisplayCode,
} from './normalize.js';
import { readResponseTextCapped } from '../common/http.js';

function isRetryableNetworkError(error) {
  return error?.name === 'TypeError' && /fetch failed/i.test(String(error?.message));
}

export function describeFetchError(error) {
  const cause = error?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(': ');
  return detail ? `${error?.message || error} (${detail})` : String(error?.message || error);
}

async function fetchCatalogWithRetry(endpoint, { attempts = 3, pauseMs = 1500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(endpoint, {
        headers: {
          Accept: 'application/xml,text/xml,*/*',
          'User-Agent': CATALOG_USER_AGENT,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= attempts || !isRetryableNetworkError(error)) throw error;
      console.warn(
        '[CCTV] Hong Kong TD catalog fetch retry',
        attempt,
        describeFetchError(error),
      );
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

const CATALOG_USER_AGENT =
  'GodsEyeView/0.1 (cctv catalog; +https://github.com/bret1976/globe)';

/** Hong Kong SAR box (HK Island, Kowloon, New Territories + slack). */
export function isLikelyHongKongCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 22.1 &&
    lat <= 22.6 &&
    lon >= 113.8 &&
    lon <= 114.45
  );
}

/**
 * Pin one HK TD still URL to tdcctv.data.one.gov.hk/{KEY}.JPG.
 * Credentials, query strings, ports, and off-tree paths are refused.
 *
 * @param {unknown} raw
 * @param {string} [cameraKey]
 * @returns {?string}
 */
export function normalizeHongKongImageUrl(raw, cameraKey = '') {
  const key = String(cameraKey || '').trim();
  const value = String(raw ?? '').trim();
  if (value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return null;
    if (parsed.port) return null;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'tdcctv.data.one.gov.hk') return null;
    parsed.protocol = 'https:';
    parsed.hostname = 'tdcctv.data.one.gov.hk';
    const pathMatch = /^\/([A-Za-z0-9_-]+)\.JPG$/.exec(parsed.pathname);
    if (!pathMatch) return null;
    if (parsed.pathname.includes('..')) return null;
    if (key && pathMatch[1] !== key) return null;
    const href = `https://tdcctv.data.one.gov.hk/${pathMatch[1]}.JPG`;
    if (!href.startsWith(HONGKONG_IMAGE_ORIGIN)) return null;
    return href;
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) return null;
  return `${HONGKONG_IMAGE_ORIGIN}${key}.JPG`;
}

/**
 * Parse DATA.GOV.HK Traffic_Camera_Locations XML into row objects.
 * @param {string} xml
 * @returns {Array<object>}
 */
export function parseHongKongCameraXml(xml) {
  const out = [];
  const blockRe = /<image\b[^>]*>([\s\S]*?)<\/image>/gi;
  let match;
  while ((match = blockRe.exec(String(xml || ''))) !== null) {
    const body = match[1];
    const field = (name) => {
      const m = new RegExp(`<${name}\\b[^>]*>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(
        body,
      );
      return m ? m[1].trim() : '';
    };
    out.push({
      key: field('key'),
      region: field('region'),
      district: field('district'),
      description: field('description'),
      latitude: field('latitude'),
      longitude: field('longitude'),
      url: field('url'),
    });
  }
  return out;
}

/**
 * One HK TD camera row → catalog source, or null.
 * @param {object} row
 * @returns {?object}
 */
export function hongkongCameraToSource(row) {
  if (!row || typeof row !== 'object') return null;
  const key = String(row.key || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(key)) return null;
  const lat = toFiniteNumber(row.latitude);
  const lon = toFiniteNumber(row.longitude);
  if (!isLikelyHongKongCoordinate(lat, lon)) return null;
  const imageUrl = normalizeHongKongImageUrl(row.url, key);
  if (!imageUrl) return null;
  const description = String(row.description || '').trim().slice(0, 140);
  const district = String(row.district || '').trim().slice(0, 60);
  const region = String(row.region || '').trim().slice(0, 60);
  const name =
    description ||
    (district ? `HK TD ${key} (${district})` : `HK TD ${key}`);
  const cameraId = `hk-td-${key}`;
  const place = [district, region].filter(Boolean).join(', ') || 'Hong Kong';
  return {
    id: cameraId,
    name,
    city: place.slice(0, 80),
    cityId: 'hongkong',
    provider: 'Hong Kong Transport Department',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 140,
    mountHeightM: 10,
    groundElevationM: 20,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'hk-td-traffic-snapshot',
    license:
      'DATA.GOV.HK / Hong Kong Transport Department — traffic snapshot images (commercial use OK with credit)',
    code: cameraDisplayCode((description || key).toUpperCase()),
  };
}

function sourcesFromHongKongRows(rows) {
  const cameras = [];
  const seen = new Set();
  for (const item of Array.isArray(rows) ? rows : []) {
    const camera = hongkongCameraToSource(item);
    if (!camera || seen.has(camera.id)) continue;
    seen.add(camera.id);
    cameras.push(camera);
  }
  return cameras;
}

function loadHongKongSnapshotRows() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, 'hongkong.snapshot.json');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function capHongKongSources(cameras) {
  const maxRaw = Number(
    process.env.CCTV_HONGKONG_MAX_SOURCES || DEFAULT_HONGKONG_MAX_SOURCES,
  );
  const maxCount = Number.isFinite(maxRaw)
    ? Math.max(8, Math.min(1000, Math.floor(maxRaw)))
    : DEFAULT_HONGKONG_MAX_SOURCES;
  return prioritizeSources(cameras, maxCount, HONGKONG_ANCHORS);
}

/**
 * Fetch Hong Kong Transport Department traffic cameras from the keyless
 * DATA.GOV.HK XML inventory. Falls back to the bundled snapshot when Railway
 * Asia (or similar) cannot reach static.data.gov.hk.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadHongKongSourcesFromOpenData() {
  try {
    const endpoint = process.env.CCTV_HONGKONG_URL || DEFAULT_HONGKONG_CCTV_URL;
    const resp = await fetchCatalogWithRetry(endpoint);
    const discardBody = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Hong Kong TD catalog redirected; redirects are not followed',
      );
      await discardBody();
    } else if (!resp.ok) {
      console.warn('[CCTV] Hong Kong TD camera download failed:', resp.status);
      await discardBody();
    } else {
      const xml = await readResponseTextCapped(resp, HONGKONG_MAX_CATALOG_BYTES);
      const rows = parseHongKongCameraXml(xml);
      const cameras = sourcesFromHongKongRows(rows);
      if (cameras.length) {
        const prioritized = capHongKongSources(cameras);
        console.log(
          `[CCTV] Loaded Hong Kong TD camera sources: ${cameras.length} live (using nearest ${prioritized.length})`,
        );
        return prioritized;
      }
      console.warn('[CCTV] Hong Kong TD live catalog was empty');
    }
  } catch (error) {
    console.warn(
      '[CCTV] Hong Kong TD camera download error:',
      describeFetchError(error),
    );
  }
  const snapshot = sourcesFromHongKongRows(loadHongKongSnapshotRows());
  if (snapshot.length) {
    const prioritized = capHongKongSources(snapshot);
    console.warn(
      `[CCTV] Hong Kong TD using bundled snapshot: ${snapshot.length} cameras (using nearest ${prioritized.length})`,
    );
    return prioritized;
  }
  return [];
}
