import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Optional on-disk persistence for Blackout state (went-dark trackers, the
 * 24 h GNSS history, the recent-flags log).
 *
 * The directory is BLACKOUT_DATA_DIR, else RAILWAY_VOLUME_MOUNT_PATH (Railway
 * sets it when a volume is attached). With neither, or when the directory is
 * not writable, everything stays in memory and status() says so — the page
 * shows that note instead of pretending history survives a restart.
 */
export function resolvePersistDir(env = process.env) {
  const own = String(env.BLACKOUT_DATA_DIR || '').trim();
  if (own) return own;
  const vol = String(env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  return vol ? path.join(vol, 'blackout') : null;
}

export function createPersistStore({ dir = resolvePersistDir(), warn = (...a) => console.warn(...a), intervalMs = 120_000 } = {}) {
  let usable = false;
  let lastError = null;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      usable = true;
    } catch (e) {
      lastError = e?.code || e?.message || 'not writable';
      warn('[blackout] persist dir unusable, staying in memory:', lastError);
    }
  }
  /** @type {Map<string, () => unknown>} */
  const savers = new Map();
  const lastSavedAt = new Map();
  let timer = null;

  function load(name) {
    if (!usable) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') warn(`[blackout] could not read ${name}:`, e?.message);
      return null;
    }
  }

  async function saveOne(name, sync = false) {
    if (!usable) return false;
    const fn = savers.get(name);
    if (!fn) return false;
    try {
      const body = JSON.stringify(fn());
      const file = path.join(dir, `${name}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      if (sync) { fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); }
      else { await fsp.writeFile(tmp, body); await fsp.rename(tmp, file); }
      lastSavedAt.set(name, Date.now());
      return true;
    } catch (e) {
      lastError = e?.message || 'write failed';
      warn(`[blackout] could not save ${name}:`, lastError);
      return false;
    }
  }

  async function saveAll() { for (const name of savers.keys()) await saveOne(name); }
  function flushSync() { for (const name of savers.keys()) saveOne(name, true); }

  /** Register a state source; returns the saved state (or null) to restore from. */
  function register(name, exportFn) {
    savers.set(name, exportFn);
    if (usable && !timer) {
      timer = setInterval(() => { saveAll(); }, intervalMs);
      timer.unref?.();
      const onExit = () => { flushSync(); };
      process.once('SIGTERM', () => { onExit(); process.exit(0); });
      process.once('beforeExit', onExit);
    }
    return load(name);
  }

  function status() {
    return usable
      ? { mode: 'disk', note: 'Went-dark state and GNSS history are saved to a persistent volume and survive restarts.', lastSavedAt: Object.fromEntries(lastSavedAt), error: lastError }
      : { mode: 'memory', note: dir ? `Persistent directory not writable (${lastError}); state is in memory and is lost on restart.` : 'No persistent volume attached; went-dark state and GNSS history are in memory and are lost on restart or redeploy.' };
  }

  return { register, load, saveAll, flushSync, status, get dir() { return usable ? dir : null; } };
}

let shared = null;
/** One store per process. */
export function blackoutStore() {
  if (!shared) shared = createPersistStore();
  return shared;
}
export function resetBlackoutStoreForTest(store = null) { shared = store; }
