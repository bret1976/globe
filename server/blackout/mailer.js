/**
 * Outgoing mail for Blackout alerts, behind one small interface:
 *   mailer.send({ to, subject, text, html, headers }) -> { ok, mode, id?, error? }
 *
 * BLACKOUT_MAIL_MODE
 *   off     – nothing is sent or logged (sign-ups still work, mail waits).
 *   dryrun  – default. Logs that a message WOULD be sent (subscriber id and
 *             subject only — never the address or the links).
 *   live    – really sends, through BLACKOUT_MAIL_PROVIDER (only "resend"
 *             today: RESEND_API_KEY + BLACKOUT_MAIL_FROM on a verified
 *             domain). Missing settings fall back to dryrun and say why.
 */
export const RESEND_URL = 'https://api.resend.com/emails';

export function mailConfig(env = process.env) {
  const want = String(env.BLACKOUT_MAIL_MODE || 'dryrun').trim().toLowerCase();
  const provider = String(env.BLACKOUT_MAIL_PROVIDER || 'resend').trim().toLowerCase();
  const from = String(env.BLACKOUT_MAIL_FROM || '').trim();
  const key = String(env.RESEND_API_KEY || '').trim();
  if (want === 'off') return { mode: 'off', provider: null, reason: 'BLACKOUT_MAIL_MODE=off' };
  if (want !== 'live') return { mode: 'dryrun', provider: null, reason: 'dry run (BLACKOUT_MAIL_MODE is not "live")' };
  if (provider !== 'resend') return { mode: 'dryrun', provider: null, reason: `unsupported BLACKOUT_MAIL_PROVIDER "${provider.slice(0, 20)}"` };
  if (!key) return { mode: 'dryrun', provider: null, reason: 'RESEND_API_KEY is not set' };
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(from)) return { mode: 'dryrun', provider: null, reason: 'BLACKOUT_MAIL_FROM is not set to a sender address' };
  return { mode: 'live', provider: 'resend', reason: null, from, key };
}

export function createMailer({ env = process.env, fetchImpl = globalThis.fetch, log = (...a) => console.log(...a) } = {}) {
  const cfg = mailConfig(env);
  const stats = { sent: 0, dryRun: 0, failed: 0, lastError: null };

  async function send({ to, subject, text, html, headers = {}, ref = '?' }) {
    if (cfg.mode === 'off') return { ok: false, mode: 'off' };
    if (cfg.mode === 'dryrun') {
      stats.dryRun += 1;
      log(`[blackout-mail] dry run: would send "${String(subject).slice(0, 120)}" to subscriber ${ref}`);
      return { ok: true, mode: 'dryrun' };
    }
    try {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.from, to: [to], subject, text, html, headers }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`provider HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      stats.sent += 1;
      return { ok: true, mode: 'live', id: body?.id || null };
    } catch (e) {
      stats.failed += 1;
      stats.lastError = String(e?.message || e).slice(0, 120);
      log(`[blackout-mail] send failed for subscriber ${ref}: ${stats.lastError}`);
      return { ok: false, mode: 'live', error: stats.lastError };
    }
  }

  return { send, get mode() { return cfg.mode; }, status: () => ({ mode: cfg.mode, provider: cfg.provider, reason: cfg.reason, ...stats }) };
}
