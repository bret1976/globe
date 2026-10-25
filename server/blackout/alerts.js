import crypto from 'node:crypto';
import { ALERT_AREAS } from './places.js';

/**
 * No-login email alerts for Blackout.
 *
 *  - Double opt-in: a sign-up is "pending" until the link in the confirmation
 *    mail is used. Nothing else is ever mailed to a pending address, and
 *    pending sign-ups expire after 48 h.
 *  - Every alert mail carries a one-click unsubscribe link (and the RFC 8058
 *    List-Unsubscribe headers). Unsubscribing deletes the record.
 *  - Digest + throttle: matching events queue up and go out as one digest at
 *    most every BLACKOUT_ALERT_MIN_INTERVAL_MIN (default 60) minutes, at most
 *    MAX_PER_DAY digests a day, MAX_EVENTS_PER_DIGEST events each.
 *  - Anti-abuse: honeypot field, same-origin check, per-IP and per-address
 *    rate limits (in memory, IP hashed), hard caps on stored records.
 *  - Addresses are stored only in the subscriber file on the persistent
 *    volume; logs and the API show a random subscriber id, never the address.
 */
export const MAX_SUBSCRIBERS = 5_000;
export const MAX_PENDING = 500;
export const PENDING_TTL_MS = 48 * 3_600_000;
export const MAX_PER_DAY = 12;
export const MAX_EVENTS_PER_DIGEST = 20;
export const MAX_QUEUE = 50;
export const ALERT_TYPES = Object.freeze(['ship', 'aircraft', 'gnss', 'reappeared']);
export const DEFAULT_TYPES = Object.freeze(['ship', 'aircraft', 'gnss']);
const IP_LIMIT = { n: 5, ms: 3_600_000 };
const EMAIL_LIMIT = { n: 3, ms: 86_400_000 };
const GLOBAL_LIMIT = { n: 200, ms: 3_600_000 };
const RESEND_CONFIRM_MS = 30 * 60_000;
const BACKFILL_MS = 2 * 3_600_000;

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export function normalizeEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(24).toString('base64url');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Does one event match a subscriber's filters? */
export function eventMatches(ev, sub) {
  const types = sub.types?.length ? sub.types : DEFAULT_TYPES;
  if (ev.type === 'reappeared') {
    if (!types.includes('reappeared')) return false;
    if (!types.includes(ev.kind === 'ship' ? 'ship' : 'aircraft')) return false;
  } else if (ev.type === 'went_dark') {
    if (!types.includes(ev.kind === 'ship' ? 'ship' : 'aircraft')) return false;
  } else if (ev.type === 'gnss_rise') {
    if (!types.includes('gnss')) return false;
  } else return false;
  if (sub.areas?.length && !sub.areas.some((a) => (ev.areas || []).includes(a))) return false;
  return true;
}

function limiter() {
  const hits = new Map();
  return (key, { n, ms }, t) => {
    const arr = (hits.get(key) || []).filter((x) => t - x < ms);
    if (arr.length >= n) { hits.set(key, arr); return false; }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 20_000) hits.delete(hits.keys().next().value);
    return true;
  };
}

export function createAlerts({ store, mailer, now = () => Date.now(), publicUrl = '', env = process.env } = {}) {
  const minIntervalMs = Math.max(5, Number(env.BLACKOUT_ALERT_MIN_INTERVAL_MIN) || 60) * 60_000;
  /** @type {Map<string, object>} id -> subscriber */
  const subs = new Map();
  const saved = store?.register('alert-subscribers', () => ({ v: 1, subs: [...subs.values()] }));
  if (saved?.v === 1 && Array.isArray(saved.subs)) for (const s of saved.subs) if (s?.id && s.email) subs.set(s.id, s);
  const allow = limiter();
  const stats = { signups: 0, rejected: 0, confirmations: 0, digests: 0, lastFlushAt: null };
  let dirty = false;
  const persist = () => { dirty = true; store?.saveNow?.('alert-subscribers').then?.(() => { dirty = false; }); };

  const base = () => String(publicUrl || '').replace(/\/+$/, '');
  const link = (path, tok) => `${base()}${path}?t=${encodeURIComponent(tok)}`;
  const byToken = (field, tok) => { if (!tok || typeof tok !== 'string') return null; for (const s of subs.values()) if (s[field] && s[field] === tok) return s; return null; };

  function expire(t) {
    let changed = false;
    for (const [id, s] of subs) if (s.status === 'pending' && t - s.createdAt > PENDING_TTL_MS) { subs.delete(id); changed = true; }
    if (changed) persist();
  }

  async function sendConfirmation(s, t) {
    if (mailer.mode === 'off') return false;
    const url = link('/watch/alerts/confirm', s.confirmToken);
    const stop = link('/watch/alerts/unsubscribe', s.unsubToken);
    const areas = s.areas.length ? s.areas.map((a) => ALERT_AREAS.find((x) => x.id === a)?.name || a).join(', ') : 'anywhere';
    const types = (s.types.length ? s.types : DEFAULT_TYPES).join(', ');
    const text = `Someone (hopefully you) asked for Blackout alerts at this address.\n\nConfirm: ${url}\n\nAlerts for: ${types} · areas: ${areas}. At most one digest per ${Math.round(minIntervalMs / 60_000)} min.\nIf this wasn't you, ignore this mail — nothing more will be sent and the request expires in 48 hours.\n\nBlackout · ${base()}/watch`;
    const html = `<p>Someone (hopefully you) asked for Blackout alerts at this address.</p><p><a href="${esc(url)}">Confirm your subscription</a></p><p>Alerts for: ${esc(types)} · areas: ${esc(areas)}. At most one digest per ${Math.round(minIntervalMs / 60_000)} min.</p><p style="color:#666">If this wasn't you, ignore this mail — nothing more will be sent and the request expires in 48 hours.</p>`;
    const r = await mailer.send({ to: s.email, subject: 'Confirm your Blackout alerts', text, html, ref: s.id, headers: { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    if (r.ok && r.mode === 'live') { s.confirmSentAt = t; stats.confirmations += 1; persist(); return true; }
    if (r.ok) s.dryRunConfirmAt = t;
    return false;
  }

  /** Public sign-up. Always answers with the same shape so addresses can't be probed. */
  async function subscribe({ email, areas = [], types = [], honeypot = '', ip = '' } = {}, t = now()) {
    const generic = { ok: true, status: 'pending', mail: mailer.mode, message: mailer.mode === 'live' ? 'Check your inbox for a confirmation link (it expires in 48 hours).' : 'Saved as pending. Email sending is not switched on yet, so no confirmation has been sent; the sign-up expires after 48 hours if it is never confirmed.' };
    if (honeypot) { stats.rejected += 1; return generic; }
    const addr = normalizeEmail(email);
    if (!addr) return { ok: false, error: 'invalid_email', message: 'Please enter a valid email address.' };
    const ipKey = sha(`ip:${ip}`);
    if (!allow(`ip:${ipKey}`, IP_LIMIT, t) || !allow('global', GLOBAL_LIMIT, t)) { stats.rejected += 1; return { ok: false, error: 'rate_limited', message: 'Too many sign-ups from here — try again in an hour.' }; }
    if (!allow(`em:${sha(addr)}`, EMAIL_LIMIT, t)) { stats.rejected += 1; return generic; }
    expire(t);
    const cleanAreas = [...new Set((Array.isArray(areas) ? areas : []).map(String))].filter((a) => ALERT_AREAS.some((x) => x.id === a)).slice(0, ALERT_AREAS.length);
    const cleanTypes = [...new Set((Array.isArray(types) ? types : []).map(String))].filter((x) => ALERT_TYPES.includes(x));
    const existing = [...subs.values()].find((s) => s.email === addr);
    if (existing) {
      if (existing.status === 'pending') {
        existing.areas = cleanAreas; existing.types = cleanTypes;
        if (!existing.confirmSentAt || t - existing.confirmSentAt > RESEND_CONFIRM_MS) await sendConfirmation(existing, t);
        persist();
      }
      // Active subscribers are not changed by an anonymous request (they can unsubscribe and re-join).
      return generic;
    }
    const pending = [...subs.values()].filter((s) => s.status === 'pending').length;
    if (subs.size >= MAX_SUBSCRIBERS || pending >= MAX_PENDING) { stats.rejected += 1; return { ok: false, error: 'full', message: 'Sign-ups are paused right now — please try again later.' }; }
    const s = { id: crypto.randomBytes(6).toString('hex'), email: addr, areas: cleanAreas, types: cleanTypes, status: 'pending', createdAt: t, confirmedAt: null, confirmToken: token(), unsubToken: token(), confirmSentAt: null, lastSentAt: null, day: null, dayCount: 0, queue: [] };
    subs.set(s.id, s);
    stats.signups += 1;
    await sendConfirmation(s, t);
    persist();
    return generic;
  }

  function confirm(tok, t = now()) {
    expire(t);
    const s = byToken('confirmToken', tok);
    if (!s) return { ok: false, error: 'unknown_or_expired' };
    if (s.status !== 'active') { s.status = 'active'; s.confirmedAt = t; s.queue = []; persist(); }
    return { ok: true, id: s.id, areas: s.areas, types: s.types };
  }

  function unsubscribe(tok) {
    const s = byToken('unsubToken', tok);
    if (!s) return { ok: true, already: true };
    subs.delete(s.id);
    persist();
    return { ok: true };
  }

  /** Queue one activity event for every matching confirmed subscriber. */
  function onEvent(ev, t = now()) {
    if (!ev || t - ev.at > BACKFILL_MS) return 0;
    let n = 0;
    for (const s of subs.values()) {
      if (s.status !== 'active' || ev.at < s.confirmedAt || !eventMatches(ev, s)) continue;
      s.queue.push({ id: ev.id, at: ev.at, text: ev.text, lat: ev.lat, lon: ev.lon, kind: ev.kind, targetId: ev.targetId });
      if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE);
      n += 1;
    }
    if (n) dirty = true;
    return n;
  }

  function digest(s, items) {
    const stop = link('/watch/alerts/unsubscribe', s.unsubToken);
    const lines = items.map((e) => `• ${utc(e.at)} — ${e.text}`);
    const extra = s.queue.length > items.length ? s.queue.length - items.length : 0;
    const text = `Blackout — ${items.length} new event${items.length === 1 ? '' : 's'} matching your alerts\n\n${lines.join('\n')}${extra ? `\n…and ${extra} more on the page.` : ''}\n\nOpen Blackout: ${base()}/watch#history\nWent-dark flags are inferred from silence, not proof of intent. Sources: AISStream (ships), adsb.lol ODbL 1.0 (military aircraft, GNSS).\n\nUnsubscribe (one click): ${stop}`;
    const html = `<p><strong>Blackout — ${items.length} new event${items.length === 1 ? '' : 's'} matching your alerts</strong></p><ul>${items.map((e) => `<li>${esc(utc(e.at))} — ${esc(e.text)}</li>`).join('')}</ul>${extra ? `<p>…and ${extra} more on the page.</p>` : ''}<p><a href="${esc(base())}/watch#history">Open Blackout</a></p><p style="color:#666;font-size:12px">Went-dark flags are inferred from silence, not proof of intent. Sources: AISStream (ships), adsb.lol ODbL 1.0 (military aircraft, GNSS).<br><a href="${esc(stop)}">Unsubscribe with one click</a></p>`;
    return { to: s.email, subject: `Blackout: ${items.length} new event${items.length === 1 ? '' : 's'}`, text, html, ref: s.id, headers: { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  }

  /** Send due confirmations and digests (throttled). Called on a timer. */
  async function flush(t = now()) {
    expire(t);
    stats.lastFlushAt = t;
    if (mailer.mode === 'off') return;
    for (const s of [...subs.values()]) {
      if (s.status === 'pending') {
        if (mailer.mode === 'live' && !s.confirmSentAt) await sendConfirmation(s, t);
        continue;
      }
      if (!s.queue.length) continue;
      if (s.lastSentAt && t - s.lastSentAt < minIntervalMs) continue;
      const day = new Date(t).toISOString().slice(0, 10);
      if (s.day !== day) { s.day = day; s.dayCount = 0; }
      if (s.dayCount >= MAX_PER_DAY) continue;
      const items = s.queue.slice(-MAX_EVENTS_PER_DIGEST).reverse();
      const r = await mailer.send(digest(s, items));
      if (r.ok) {
        s.queue = []; s.lastSentAt = t; s.dayCount += 1; stats.digests += 1; persist();
      }
    }
    if (dirty) persist();
  }

  function status() {
    let active = 0, pending = 0, queued = 0;
    for (const s of subs.values()) { if (s.status === 'active') active += 1; else pending += 1; queued += s.queue?.length || 0; }
    return { mail: mailer.status(), subscribers: { active, pending, max: MAX_SUBSCRIBERS }, queuedEvents: queued, throttle: { minIntervalMin: Math.round(minIntervalMs / 60_000), maxPerDay: MAX_PER_DAY, maxEventsPerDigest: MAX_EVENTS_PER_DIGEST }, ...stats };
  }

  return { subscribe, confirm, unsubscribe, onEvent, flush, status, _subsForTest: subs };
}
