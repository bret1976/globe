/**
 * Host-wide adsb.lol rate-limit gate.
 *
 * api.adsb.lol limits each client IP (x-ratelimit-limit: 4/s, 60/min) and a
 * hosted server shares its egress IP with every route that calls it: the
 * regional flights feed, the military feed and GNSS integrity. Before this
 * gate only the military route backed off after a 429. The flights route
 * re-asked on every poll (up to four times per request while falling through
 * to OpenSky), which kept the limit tripped and left a cold view waiting
 * ~10 s for a 502. A 429 seen by any route now pauses every adsb.lol caller
 * for the Retry-After period (bounded), doubling while 429s repeat.
 *
 * The limit header also carries a DAILY window: `500;w=86400`. Every caller
 * together used to send ~4,600 requests a day (military detector every 30 s,
 * six GNSS regions every 5 min, plus viewer traffic), ~9x that quota, so the
 * host spent most of each day rate-limited. adsbLolTake() keeps a rolling
 * 24 h count and refuses once the shared budget is spent; viewer-driven
 * reads get a small slice so they cannot starve the background pollers.
 */
const MIN_COOLDOWN_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

const DAY_MS = 86_400_000;
/** Rolling 24 h request budget, kept under adsb.lol's published 500/day. */
export const ADSBLOL_DAILY_BUDGET = 450;
/** Slice of that budget viewer-driven routes (regional fallback, GNSS views, mil proxy) may use. */
export const ADSBLOL_INTERACTIVE_DAILY = 30;

let cooldownUntil = 0;
let consecutive429 = 0;
/** Send times (epoch ms) in the last 24 h; `interactive` sends tracked separately. */
let sent = [];
let sentInteractive = [];

function prune(now) {
  const since = now - DAY_MS;
  while (sent.length && sent[0] <= since) sent.shift();
  while (sentInteractive.length && sentInteractive[0] <= since) sentInteractive.shift();
}

/**
 * Reserve one adsb.lol request. Returns false (and reserves nothing) during a
 * 429 cooldown or once the rolling daily budget is spent.
 */
export function adsbLolTake({ interactive = false } = {}, now = Date.now()) {
  if (now < cooldownUntil) return false;
  prune(now);
  if (sent.length >= ADSBLOL_DAILY_BUDGET) return false;
  if (interactive && sentInteractive.length >= ADSBLOL_INTERACTIVE_DAILY) return false;
  sent.push(now);
  if (interactive) sentInteractive.push(now);
  return true;
}

/** Budget use for health output. */
export function adsbLolBudget(now = Date.now()) {
  prune(now);
  return { windowMs: DAY_MS, budget: ADSBLOL_DAILY_BUDGET, used: sent.length, interactiveUsed: sentInteractive.length, interactiveBudget: ADSBLOL_INTERACTIVE_DAILY, cooldownMs: Math.max(0, cooldownUntil - now), nextFreeAt: sent.length >= ADSBLOL_DAILY_BUDGET ? sent[0] + DAY_MS : null };
}

/** Latest raw /v2/mil body fetched by the server-side detector (shared with the browser proxy). */
let milBody = null;
let milBodyAt = 0;
export function shareAdsbLolMilBody(body, at = Date.now()) { milBody = body; milBodyAt = at; }
export function sharedAdsbLolMilBody() { return milBody == null ? null : { body: milBody, at: milBodyAt }; }

export function retryAfterMs(headers, now) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > now ? at - now : null;
}

/** Milliseconds left in the shared cooldown (0 when adsb.lol may be asked). */
export function adsbLolCooldownRemainingMs(now = Date.now()) {
  return Math.max(0, cooldownUntil - now);
}

/** Whether adsb.lol may be asked now (false during the shared cooldown). */
export function adsbLolMayRequest(now = Date.now()) {
  return now >= cooldownUntil;
}

/** Record an upstream status; a 429 starts or extends the shared cooldown. */
export function noteAdsbLolResponse(status, headers, now = Date.now()) {
  if (status !== 429) {
    if (status >= 200 && status < 300) consecutive429 = 0;
    return 0;
  }
  consecutive429 += 1;
  const hinted = retryAfterMs(headers, now);
  const base = hinted ?? DEFAULT_COOLDOWN_MS * 2 ** (consecutive429 - 1);
  const delay = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, base));
  cooldownUntil = Math.max(cooldownUntil, now + delay);
  return cooldownUntil - now;
}

/** Test hook: forget all gate state. */
export function resetAdsbLolGate() {
  cooldownUntil = 0;
  consecutive429 = 0;
  sent = [];
  sentInteractive = [];
  milBody = null;
  milBodyAt = 0;
}
