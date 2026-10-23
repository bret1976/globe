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
 */
const MIN_COOLDOWN_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

let cooldownUntil = 0;
let consecutive429 = 0;

function retryAfterMs(headers, now) {
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
}
