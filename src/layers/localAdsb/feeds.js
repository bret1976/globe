import {
  localAdsbRecordIsLive,
  localAdsbRecordIsNewer,
  normalizeDump1090Aircraft,
} from '../../sources/adsbRecords.js';

/** Browser storage key for the operator's own decoder feed URL (GodsEye). */
export const BROWSER_FEED_STORAGE_KEY = 'godseye.localReceiverFeedUrl';
/** A feed document older than this reads `stale` (matches the server route). */
const BROWSER_FEED_STALE_MS = 10_000;

/**
 * Normalize what an operator types into the Radio card: a full aircraft.json
 * URL, or a dump1090/readsb/tar1090 base URL ("http://pi.local:8080/",
 * "http://192.168.1.20/tar1090"), optionally prefixed "978=" for a UAT
 * decoder. Returns null for anything that is not http(s).
 * @param {unknown} value
 * @returns {{band:'1090'|'978', url:string}|null}
 */
export function parseBrowserFeedInput(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  let band = '1090';
  const banded = /^(1090|978)\s*=\s*(.+)$/.exec(text);
  if (banded) {
    band = banded[1];
    text = banded[2].trim();
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!/\.json$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/data/aircraft.json`;
  }
  return { band, url: url.toString() };
}

function defaultBrowserFeedStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Why a browser-side feed request cannot work from this page, before trying.
 * An https page may not read a plain-http LAN receiver (mixed content);
 * loopback is the exception browsers allow.
 */
function browserFeedBlockReason(feedUrl, pageUrl) {
  try {
    const target = new URL(feedUrl);
    const page = new URL(pageUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
      target.hostname,
    );
    if (page.protocol === 'https:' && target.protocol === 'http:' && !loopback)
      return 'mixed-content';
  } catch {
    /* unknown page origin: just try */
  }
  return null;
}

/** Same-origin route served by `server/providers/local-receivers.js`. */
export const LOCAL_RECEIVERS_URL = '/api/local-receivers/aircraft';
export const LOCAL_RECEIVER_POLL_MS = 1_000;
/**
 * Browser-side deadline for one route request, body included. The server
 * bounds each upstream read at 2 s; this bounds the browser-to-server leg.
 */
export const LOCAL_RECEIVER_REQUEST_TIMEOUT_MS = 5_000;

function abortError() {
  const error = new Error('Local receiver request aborted');
  error.name = 'AbortError';
  return error;
}

/** Reject with an AbortError as soon as `signal` aborts. */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
}

function shiftTime(value, offset) {
  return Number.isFinite(value) ? value + offset : value;
}

/**
 * Browser poller for the server's local decoder feeds.
 *
 * Polls only between `start()` and `stop()` (the Local ADS-B layer calls them
 * on enable/disable), and only while the route reports `configured`: an
 * unconfigured server, or a build without the route, stops the loop after one
 * request. `probe()` makes that one request without polling, so the Radio card
 * can show which feeds exist before the layer is turned on.
 *
 * Records are rebased from the server clock to this browser's clock and kept
 * by ICAO and band for up to 60 s after their last message, so a feed that
 * drops an aircraft or goes briefly unreachable does not erase it at once.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.url]
 * @param {number} [options.intervalMs]
 * @param {number} [options.requestTimeoutMs] Deadline per request.
 * @param {() => number} [options.now]
 * @returns {object} Feed session: start, stop, probe, getState, subscribe.
 */
export function createLocalReceiverFeeds({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = LOCAL_RECEIVERS_URL,
  intervalMs = LOCAL_RECEIVER_POLL_MS,
  requestTimeoutMs = LOCAL_RECEIVER_REQUEST_TIMEOUT_MS,
  now = Date.now,
  storage = defaultBrowserFeedStorage(),
  pageUrl = () => globalThis.location?.href || '',
} = {}) {
  const listeners = new Set();
  const retained = new Map();
  /** Abort controllers of requests still in flight. */
  const inFlight = new Set();
  let state = {
    configured: null,
    polling: false,
    feeds: [],
    records: [],
    error: null,
    updatedAt: null,
  };
  let generation = 0;
  let timer = null;
  let probing = null;

  function emit(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function retain(records, at) {
    for (const record of records) {
      if (!record?.icao) continue;
      // Two feeds on one band both report an aircraft: keep the fresher
      // record, never simply the one listed (or polled) last.
      const key = `${record.icao}|${record.band}`;
      const current = retained.get(key);
      if (!current || !localAdsbRecordIsNewer(current, record))
        retained.set(key, record);
    }
    for (const [key, record] of retained) {
      if (!localAdsbRecordIsLive(record, at)) retained.delete(key);
    }
    return [...retained.values()];
  }

  /** One fetch with a deadline through the body, abortable by stop. */
  async function fetchJson(target, init = {}) {
    const controller = new AbortController();
    inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await untilAborted(
        fetchImpl(target, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
          ...init,
        }),
        controller.signal,
      );
      if (!response?.ok) throw new Error('local receiver route unavailable');
      return await untilAborted(response.json(), controller.signal);
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
  }

  let memoryFeed = null;
  function readBrowserFeedSetting() {
    let text = memoryFeed;
    try {
      text = storage?.getItem?.(BROWSER_FEED_STORAGE_KEY) ?? memoryFeed;
    } catch {
      /* storage unavailable */
    }
    return parseBrowserFeedInput(text);
  }

  /**
   * Read the operator's own dump1090/readsb feed directly from this browser.
   * The receiver must answer CORS (or be loopback on the same machine); a
   * failure is a feed status, never an exception, so the server route and
   * the USB receiver keep working.
   */
  async function readBrowserFeed(feed) {
    const summary = { band: feed.band, label: 'browser', url: feed.url, origin: 'browser' };
    const blocked = browserFeedBlockReason(feed.url, pageUrl());
    if (blocked)
      return {
        status: { ...summary, status: 'unreachable', reason: blocked, aircraft: 0, ageMs: null },
        records: [],
      };
    let json;
    try {
      json = await fetchJson(feed.url, { headers: {}, credentials: 'omit' });
    } catch (error) {
      return {
        status: { ...summary, status: 'unreachable', reason: 'no-response', aircraft: 0, ageMs: null },
        records: [],
      };
    }
    const receivedAt = now();
    const feedNowS = Number(json?.now);
    const ageMs = Number.isFinite(feedNowS)
      ? Math.max(0, Math.round(receivedAt - feedNowS * 1000))
      : 0;
    const records = normalizeDump1090Aircraft(json, receivedAt - ageMs, {
      band: feed.band,
    });
    if (!Array.isArray(json?.aircraft))
      return {
        status: { ...summary, status: 'invalid', reason: 'not-aircraft-json', aircraft: 0, ageMs: null },
        records: [],
      };
    return {
      status: {
        ...summary,
        status: ageMs > BROWSER_FEED_STALE_MS ? 'stale' : 'live',
        aircraft: records.length,
        ageMs,
      },
      records,
    };
  }

  /**
   * One poll: the server route (decoder feeds configured with
   * LOCAL_RECEIVER_FEEDS) plus, when the operator saved one, a decoder feed
   * this browser reads itself. Either may be absent; both answers merge into
   * the route's body shape.
   */
  async function request() {
    const browserFeed = readBrowserFeedSetting();
    const [server, browser] = await Promise.all([
      fetchJson(url).catch((error) => (browserFeed ? null : Promise.reject(error))),
      browserFeed ? readBrowserFeed(browserFeed) : null,
    ]);
    if (!browser) return server;
    const at = now();
    const serverConfigured = server?.configured === true;
    const generatedAt =
      serverConfigured && Number.isFinite(server.generatedAt) ? server.generatedAt : at;
    // Browser records are on this clock; express them on the server clock so
    // apply() rebases every record by the same offset.
    const shift = generatedAt - at;
    const browserRecords = browser.records.map((record) => ({
      ...record,
      lastPositionAt: shiftTime(record.lastPositionAt, shift),
      lastMessageAt: shiftTime(record.lastMessageAt, shift),
    }));
    return {
      configured: true,
      generatedAt,
      feeds: [...(serverConfigured && Array.isArray(server.feeds) ? server.feeds : []), browser.status],
      records: [
        ...(serverConfigured && Array.isArray(server.records) ? server.records : []),
        ...browserRecords,
      ],
    };
  }

  function abortInFlight() {
    for (const controller of inFlight) controller.abort();
    inFlight.clear();
  }

  function apply(body) {
    if (body?.configured !== true) {
      retained.clear();
      emit({
        configured: false,
        polling: false,
        feeds: [],
        records: [],
        error: null,
      });
      return false;
    }
    const at = now();
    const offset = Number.isFinite(body.generatedAt)
      ? at - body.generatedAt
      : 0;
    const records = (Array.isArray(body.records) ? body.records : []).map(
      (record) => ({
        ...record,
        lastPositionAt: shiftTime(record.lastPositionAt, offset),
        lastMessageAt: shiftTime(record.lastMessageAt, offset),
      }),
    );
    emit({
      configured: true,
      feeds: Array.isArray(body.feeds) ? body.feeds : [],
      records: retain(records, at),
      error: null,
      updatedAt: at,
    });
    return true;
  }

  function fail() {
    // A route that never answered means there is nothing to poll; a route
    // that answered before is reported unreachable and polled again.
    if (state.configured !== true) {
      emit({ configured: false, polling: false, error: 'unavailable' });
      return false;
    }
    emit({
      feeds: state.feeds.map((feed) =>
        feed.status === 'invalid'
          ? feed
          : { ...feed, status: 'unreachable', aircraft: 0 },
      ),
      records: retain([], now()),
      error: 'unavailable',
    });
    return true;
  }

  async function tick(current) {
    timer = null;
    let keepPolling;
    try {
      const body = await request();
      if (current !== generation) return;
      keepPolling = apply(body);
    } catch {
      if (current !== generation) return;
      keepPolling = fail();
    }
    if (!keepPolling) {
      generation += 1;
      return;
    }
    timer = setTimeout(() => void tick(current), intervalMs);
  }

  return {
    /** Start polling (no-op while already polling). */
    start() {
      if (state.polling) return;
      generation += 1;
      emit({ polling: true });
      void tick(generation);
    },

    /** Stop polling; the last feed statuses stay readable. */
    stop() {
      generation += 1;
      clearTimeout(timer);
      timer = null;
      abortInFlight();
      if (state.polling) emit({ polling: false });
    },

    /**
     * Ask the route once whether feeds are configured, without polling.
     * @returns {Promise<void>}
     */
    probe() {
      if (state.polling || state.configured !== null) return Promise.resolve();
      if (!probing) {
        const current = generation;
        probing = request()
          .then((body) => {
            if (current === generation && !state.polling) apply(body);
          })
          .catch(() => {
            if (current === generation && !state.polling)
              emit({ configured: false, error: 'unavailable' });
          })
          .finally(() => {
            probing = null;
          });
      }
      return probing;
    },

    getState: () => state,

    /** The operator's saved browser-side decoder feed, or null. */
    getBrowserFeed: () => readBrowserFeedSetting(),

    /**
     * Save (or clear, with an empty value) the browser-side decoder feed.
     * Returns the parsed feed, null when cleared, or false when invalid.
     */
    setBrowserFeed(value) {
      const text = String(value ?? '').trim();
      memoryFeed = text || null;
      if (!text) {
        try {
          storage?.removeItem?.(BROWSER_FEED_STORAGE_KEY);
        } catch {
          /* storage unavailable */
        }
        retained.clear();
        const wasPolling = state.polling;
        this.stop();
        emit({ configured: null, feeds: [], records: [], error: null });
        if (wasPolling) this.start();
        else void this.probe();
        return null;
      }
      const parsed = parseBrowserFeedInput(text);
      if (!parsed) return false;
      try {
        storage?.setItem?.(BROWSER_FEED_STORAGE_KEY, text);
      } catch {
        /* storage unavailable: the feed still applies until reload */
      }
      const wasPolling = state.polling;
      this.stop();
      emit({ configured: null });
      if (wasPolling) this.start();
      else void this.probe();
      return parsed;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      this.stop();
      listeners.clear();
      retained.clear();
    },
  };
}
