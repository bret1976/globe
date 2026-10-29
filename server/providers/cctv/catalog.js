import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CCTV_SOURCE_FILE,
  CCTV_SOURCE_CACHE_MS,
  CCTV_PACK_LAST_GOOD_MAX_AGE_MS,
} from './constants.js';
import { allocateSourceCap, resolveCatalogCap } from './cap.js';
import { loadGroundHeights, joinGroundHeights } from './groundHeights.js';
import { normalizeSourceItem } from './normalize.js';
import {
  loadAustinSourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadTflSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadTxdotSourcesFromOpenData,
  loadTallinnSourcesFromCatalog,
  loadTarkteeSourcesFromDatex,
  loadWarendorfSourcesFromCatalog,
  loadNswSourcesFromOpenData,
  loadCalgarySourcesFromOpenData,
  loadCataloniaSourcesFromOpenData,
  loadKingCountySourcesFromOpenData,
  loadVegvesenSourcesFromOpenData,
  loadTorontoSourcesFromOpenData,
} from './sources.js';
import { loadMdchartSourcesFromOpenData } from './mdchart.js';
import { loadDdotSourcesFromGis } from './ddot.js';
import { loadColoradoSourcesFromOpenData } from './colorado.js';
import { loadIowaDotSourcesFromOpenData } from './iowadot.js';
import { loadVegagerdinSourcesFromOpenData } from './vegagerdin.js';
import { loadNycTmcSourcesFromOpenData } from './nyctmc.js';
import { loadOregonSourcesFromOpenData } from './oregon.js';
import { loadWsdotSourcesFromOpenData } from './wsdot.js';
import { loadHongKongSourcesFromOpenData } from './hongkong.js';
import { loadMndotSources } from './mndot.js';

/** Env kill switch: unset or anything but "0" means enabled. */
const envEnabled = (name) => String(process.env[name] || '1').trim() !== '0';

/**
 * Live open-data packs, in merge order. Adding a region is one entry here
 * plus its loader in sources.js; the catalog cap is shared across entries
 * round-robin (cap.js), so a new pack never silently evicts an older one.
 * Each pack fails independently (allSettled) and is gated by its own env
 * kill switch.
 */
const LIVE_PACKS = [
  { name: 'austin', enabled: () => true, load: loadAustinSourcesFromOpenData },
  {
    name: 'caltrans',
    enabled: () => true,
    load: loadCaltransSourcesFromOpenData,
  },
  {
    name: 'tfl',
    enabled: () => envEnabled('CCTV_TFL_ENABLED'),
    load: loadTflSourcesFromOpenData,
  },
  {
    name: 'ontario',
    enabled: () => envEnabled('CCTV_ONTARIO_ENABLED'),
    load: loadOntarioSourcesFromOpenData,
  },
  {
    name: 'fintraffic',
    enabled: () => envEnabled('CCTV_FINTRAFFIC_ENABLED'),
    load: loadFintrafficSourcesFromOpenData,
  },
  {
    name: 'drivebc',
    enabled: () => envEnabled('CCTV_DRIVEBC_ENABLED'),
    load: loadDriveBcSourcesFromOpenData,
  },
  {
    name: 'txdot',
    enabled: () => envEnabled('CCTV_TXDOT_ENABLED'),
    load: loadTxdotSourcesFromOpenData,
  },
  {
    name: 'tallinn',
    enabled: () => envEnabled('CCTV_TALLINN_ENABLED'),
    load: loadTallinnSourcesFromCatalog,
  },
  {
    name: 'tarktee',
    enabled: () => envEnabled('CCTV_TARKTEE_ENABLED'),
    load: loadTarkteeSourcesFromDatex,
  },
  {
    name: 'warendorf',
    enabled: () => envEnabled('CCTV_WARENDORF_ENABLED'),
    load: loadWarendorfSourcesFromCatalog,
  },
  {
    name: 'nsw',
    enabled: () => envEnabled('CCTV_NSW_ENABLED'),
    load: loadNswSourcesFromOpenData,
  },
  {
    name: 'calgary',
    enabled: () => envEnabled('CCTV_CALGARY_ENABLED'),
    load: loadCalgarySourcesFromOpenData,
  },
  {
    name: 'mdchart',
    enabled: () => envEnabled('CCTV_MDCHART_ENABLED'),
    load: loadMdchartSourcesFromOpenData,
  },
  {
    name: 'ddot',
    enabled: () => envEnabled('CCTV_DDOT_ENABLED'),
    load: loadDdotSourcesFromGis,
  },
  {
    name: 'colorado',
    enabled: () => envEnabled('CCTV_COLORADO_ENABLED'),
    load: loadColoradoSourcesFromOpenData,
  },
  {
    name: 'catalonia',
    enabled: () => envEnabled('CCTV_CATALONIA_ENABLED'),
    load: loadCataloniaSourcesFromOpenData,
  },
  {
    name: 'kingcounty',
    enabled: () => envEnabled('CCTV_KINGCOUNTY_ENABLED'),
    load: loadKingCountySourcesFromOpenData,
  },
  {
    name: 'vegvesen',
    enabled: () => envEnabled('CCTV_VEGVESEN_ENABLED'),
    load: loadVegvesenSourcesFromOpenData,
  },
  {
    name: 'iowadot',
    enabled: () => envEnabled('CCTV_IOWADOT_ENABLED'),
    load: loadIowaDotSourcesFromOpenData,
  },
  {
    name: 'vegagerdin',
    enabled: () => envEnabled('CCTV_VEGAGERDIN_ENABLED'),
    load: loadVegagerdinSourcesFromOpenData,
  },
  {
    name: 'nyctmc',
    enabled: () => envEnabled('CCTV_NYCTMC_ENABLED'),
    load: loadNycTmcSourcesFromOpenData,
  },
  {
    name: 'oregon',
    enabled: () => envEnabled('CCTV_OREGON_ENABLED'),
    load: loadOregonSourcesFromOpenData,
  },
  {
    name: 'wsdot',
    enabled: () => envEnabled('CCTV_WSDOT_ENABLED'),
    load: loadWsdotSourcesFromOpenData,
  },
  {
    name: 'hongkong',
    enabled: () => envEnabled('CCTV_HONGKONG_ENABLED'),
    load: loadHongKongSourcesFromOpenData,
  },
  {
    name: 'toronto',
    enabled: () => envEnabled('CCTV_TORONTO_ENABLED'),
    load: loadTorontoSourcesFromOpenData,
  },
  {
    // Minnesota DOT (MnDOT) IRIS cameras; port of upstream gods-eye-view #1437.
    name: 'mndot',
    enabled: () => envEnabled('CCTV_MNDOT_ENABLED'),
    load: loadMndotSources,
  },
];
/**
 * Load CCTV sources from a local JSON file (CCTV_SOURCES_FILE env or default).
 *
 * @returns {Array<object>} Array of raw source objects, or [] on error.
 */
function loadSourcesFromFile(sourceRoot) {
  const sourceFile = process.env.CCTV_SOURCES_FILE || DEFAULT_CCTV_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(sourceRoot, sourceFile);
  try {
    if (!fs.existsSync(resolved)) return [];
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      '[CCTV] failed to read source file:',
      resolved,
      error?.message || error,
    );
    return [];
  }
}

/**
 * Load CCTV sources from the CCTV_SOURCES_JSON env variable (inline JSON).
 *
 * @returns {Array<object>} Array of raw source objects, or [] if unset/invalid.
 */
function loadSourcesFromEnv() {
  const raw = process.env.CCTV_SOURCES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Create an independent catalog rooted in the consuming application. */
export function createCctvCatalog({ sourceRoot = process.cwd() } = {}) {
  /** @type {Array<object>} Cached merged + normalized CCTV source list. */
  let _cctvSourceCache = [];
  /** @type {number} Epoch-ms when the source cache was last refreshed. */
  let _cctvSourceCacheAt = 0;
  /** @type {Promise<Array<object>>|null} In-flight refresh, shared by concurrent
   * callers so a post-TTL burst launches ONE refetch, not one per request. */
  let _cctvSourceInflight = null;
  /** @type {Map<string, {sources: Array<object>, at: number}>} Each live
   * pack's last non-empty result, kept so one slow or failed upstream fetch
   * doesn't drop that region's cameras until the next refresh. */
  const _packLastGood = new Map();

  /**
   * Assemble and cache the merged CCTV source list.
   *
   * Merges every source pack (live open-data packs, local file, env
   * variable), deduplicates by ID, shares the catalog cap fairly across
   * packs, and caches for CCTV_SOURCE_CACHE_MS. Past that, the cached list is
   * returned while a background refresh replaces it; only a first load waits
   * (port of upstream gods-eye-view #1234).
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function getCctvSources() {
    const now = Date.now();
    if (
      _cctvSourceCache.length &&
      now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS
    ) {
      return _cctvSourceCache;
    }
    // Single-flight: a burst of requests arriving past the TTL shares ONE refresh
    // instead of each launching the full multi-provider refetch. The `.finally`
    // clears the ref so the next post-TTL cycle starts fresh.
    if (!_cctvSourceInflight) {
      _cctvSourceInflight = refreshCctvSources().finally(() => {
        _cctvSourceInflight = null;
      });
      // A background refresh has no caller waiting on it: report its failure
      // here, once per refresh rather than once per request it serves. Keep
      // the old catalog for another TTL, as an empty refresh does, so a refresh
      // that keeps failing is retried once per TTL, not back to back.
      if (_cctvSourceCache.length) {
        _cctvSourceInflight.catch((error) => {
          _cctvSourceCacheAt = Date.now();
          console.warn(
            '[CCTV] background catalog refresh failed; serving',
            _cctvSourceCache.length,
            'cameras from the last catalog:',
            error?.message || error,
          );
        });
      }
    }
    // With a catalog in hand, answer with it while the refresh runs: the
    // refresh lasts as long as the slowest pack (Tarktee's DATEX feeds take up
    // to its 30 s timeout), and every camera frame/media/stream request would
    // otherwise wait for it. Only the first load, with nothing to serve yet,
    // waits.
    return _cctvSourceCache.length ? _cctvSourceCache : _cctvSourceInflight;
  }

  getCctvSources.snapshot = () => _cctvSourceCache;
  getCctvSources.refreshing = () => Boolean(_cctvSourceInflight);
  getCctvSources.prefetch = () => {
    void getCctvSources();
  };

  /**
   * Assemble and cache the merged CCTV source list from file/env + live packs.
   * Always resolves (loaders self-catch to []); on a fully-empty refresh with a
   * good prior catalog it serves stale rather than blanking the CCTV layer.
   *
   * @returns {Promise<Array<object>>} Deduplicated, capped source list.
   */
  async function refreshCctvSources() {
    const fromFile = loadSourcesFromFile(sourceRoot);
    const fromEnv = loadSourcesFromEnv();

    const forceAustin =
      String(process.env.CCTV_FORCE_AUSTIN || '').trim() === '1';
    const preferAustin =
      String(process.env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
    // Live open-data packs load unless a file/env pack is configured and live
    // packs aren't forced — the same gate that governed the Austin-only fetch
    // now governs every entry in LIVE_PACKS.
    const needsLiveSources =
      forceAustin || (fromFile.length + fromEnv.length === 0 && preferAustin);
    const liveResults = needsLiveSources
      ? await Promise.allSettled(
          // Invoked inside the promise so a loader that throws synchronously
          // (a file-based pack on a malformed row) is isolated like any other
          // failed pack instead of rejecting the whole refresh.
          LIVE_PACKS.map((pack) =>
            Promise.resolve().then(() =>
              pack.enabled() ? pack.load({ sourceRoot }) : [],
            ),
          ),
        )
      : [];
    // Live packs first so file/env overrides win on duplicate IDs; each pack
    // keeps its own priority order and the catalog cap is shared fairly.
    const normalizePack = (name, items) => ({
      name,
      sources: items
        .filter((item) => item && typeof item === 'object')
        .map((item) => normalizeSourceItem(item))
        .filter((item) => item.id),
    });
    const refreshedAt = Date.now();
    const livePacks = LIVE_PACKS.map((pack, index) => {
      const fresh = normalizePack(
        pack.name,
        liveResults[index]?.status === 'fulfilled' &&
          Array.isArray(liveResults[index].value)
          ? liveResults[index].value
          : [],
      );
      if (!needsLiveSources) return fresh;
      if (fresh.sources.length) {
        _packLastGood.set(pack.name, { sources: fresh.sources, at: refreshedAt });
        return fresh;
      }
      // An enabled pack that timed out or came back empty keeps its last good
      // cameras for a while; a pack switched off by its env flag drops them.
      const last = _packLastGood.get(pack.name);
      if (
        pack.enabled() &&
        last &&
        refreshedAt - last.at <= CCTV_PACK_LAST_GOOD_MAX_AGE_MS
      ) {
        console.warn(
          `[CCTV] ${pack.name} refresh returned no cameras; keeping its last ${last.sources.length} from ${Math.round((refreshedAt - last.at) / 60000)} min ago`,
        );
        return { name: pack.name, sources: last.sources };
      }
      _packLastGood.delete(pack.name);
      return fresh;
    });
    const packs = [
      ...livePacks,
      normalizePack('file', fromFile),
      normalizePack('env', fromEnv),
    ];
    const maxCount = resolveCatalogCap(process.env.CCTV_MAX_SOURCES);
    const allocation = allocateSourceCap(packs, maxCount);
    // Shipped ground heights (src/data/local_data/cctv_ground_heights/, produced by
    // scripts/precompute-cctv-heights.mjs) ride along on the served source so
    // the client can place a camera and its monitor plane with zero sampling.
    const capped = joinGroundHeights(
      allocation.sources,
      loadGroundHeights(sourceRoot),
    );
    const trimmed = allocation.packs.filter((pack) => pack.kept < pack.offered);
    if (trimmed.length) {
      const detail = trimmed
        .map((pack) => `${pack.name} ${pack.kept}/${pack.offered}`)
        .join(', ');
      console.warn(
        `[CCTV] source catalog exceeds cap ${maxCount}; shared round-robin across packs (${detail}). Raise CCTV_MAX_SOURCES or lower a per-pack cap to change the mix.`,
      );
    }
    if (capped.length > 0 || _cctvSourceCache.length === 0) {
      _cctvSourceCache = capped;
    } else {
      // Every source came back empty (all live packs timed out / upstream outage)
      // but a good catalog is already cached — serve it stale rather than blanking
      // every CCTV route. Advancing the timestamp waits one TTL before retrying,
      // which (with single-flight) bounds load on a persistently-down upstream.
      console.warn(
        `[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`,
      );
    }
    _cctvSourceCacheAt = Date.now();
    return _cctvSourceCache;
  }

  return getCctvSources;
}
