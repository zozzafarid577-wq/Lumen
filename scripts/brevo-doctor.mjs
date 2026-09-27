// Ask Brevo why it is refusing, instead of guessing.
//
// "blocked : due to blacklist user" is the same sentence for half a
// dozen different causes, and every one of them is visible through the
// API — the account's state, which senders are verified, who is on the
// blocklist and the reason each of them got there, and the event trail
// for one address.
//
//   echo 'BREVO_API_KEY=xkeysib-…' > .env.local
//   node scripts/brevo-doctor.mjs                     # the account
//   node scripts/brevo-doctor.mjs someone@example.com # and one address
//
// Prints no secrets: the key is never echoed, and addresses are only
// shown when they were asked about.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  for (const line of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* fall back to the real environment */ }

const KEY = (process.env.BREVO_API_KEY || '').trim();
if (!KEY) {
  console.error('No BREVO_API_KEY. Put one in .env.local first (it is git-ignored).');
  process.exit(1);
}

const who = process.argv[2];

async function get(path) {
  const resp = await fetch(`https://api.brevo.com/v3${path}`, {
    headers: { 'api-key': KEY, Accept: 'application/json' },
  });
  const body = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, body };
}

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(`── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`); };

// ── The account itself ────────────────────────────────────────────
head('Account');
const account = await get('/account');
if (!account.ok) {
  line(`  Could not read the account: ${account.body?.message || account.status}`);
  if (account.status === 401) line('  That usually means the key is wrong, revoked, or from another account.');
} else {
  const a = account.body;
  line(`  ${a.companyName || '(no company name)'} · ${a.email || ''}`);
  const plans = Array.isArray(a.plan) ? a.plan : [];
  for (const p of plans) {
    line(`  plan: ${p.type}${p.credits != null ? ` · ${p.credits} ${p.creditsType || 'credits'} left` : ''}`);
  }
  if (!plans.length) line('  plan: (none reported)');
}

// ── Senders ───────────────────────────────────────────────────────
// A send from an address that is not verified is refused, sometimes
// with a message about something else entirely.
head('Senders');
const senders = await get('/senders');
if (!senders.ok) {
  line(`  Could not read senders: ${senders.body?.message || senders.status}`);
} else {
  for (const s of senders.body?.senders || []) {
    line(`  ${s.active ? 'verified  ' : 'UNVERIFIED'} ${s.email}${s.name ? ` (${s.name})` : ''}`);
  }
  if (!(senders.body?.senders || []).length) line('  none');
}

// ── Authenticated domains ─────────────────────────────────────────
head('Domains');
const domains = await get('/senders/domains');
if (!domains.ok) {
  line(`  Could not read domains: ${domains.body?.message || domains.status}`);
} else {
  for (const d of domains.body?.domains || []) {
    const auth = d.authenticated ? 'authenticated' : 'NOT AUTHENTICATED';
    line(`  ${auth}  ${d.domain_name || d.domain}${d.verified === false ? ' · not verified' : ''}`);
  }
  if (!(domains.body?.domains || []).length) line('  none');
}

// ── The blocklist ─────────────────────────────────────────────────
// The reason on each row is the part that matters: a hard bounce is a
// dead address, a spam report is a person, and "adminBlocked" is
// somebody having pressed a button.
head('Blocked contacts (transactional)');
const blocked = await get('/smtp/blockedContacts?limit=50');
if (!blocked.ok) {
  line(`  Could not read the blocklist: ${blocked.body?.message || blocked.status}`);
} else {
  const rows = blocked.body?.contacts || [];
  for (const c of rows) {
    line(`  ${c.email}`);
    line(`      reason: ${c.reason?.code || '?'} — ${c.reason?.message || ''}`);
    if (c.blockedAt) line(`      since:  ${c.blockedAt}`);
  }
  line(`  ${rows.length} blocked${rows.length >= 50 ? ' (showing the first 50)' : ''}`);
}

// ── One address, in detail ────────────────────────────────────────
if (who) {
  head(`Events for ${who}`);
  const events = await get(`/smtp/statistics/events?limit=20&email=${encodeURIComponent(who)}`);
  if (!events.ok) {
    line(`  Could not read events: ${events.body?.message || events.status}`);
  } else {
    const rows = events.body?.events || [];
    for (const e of rows) {
      line(`  ${e.date}  ${e.event}${e.reason ? ` — ${e.reason}` : ''}`);
      if (e.subject) line(`      ${e.subject}`);
    }
    if (!rows.length) line('  no events in the window Brevo keeps');
  }

  head(`Is ${who} a contact, and is it blacklisted?`);
  const contact = await get(`/contacts/${encodeURIComponent(who)}`);
  if (contact.status === 404) {
    line('  Not a contact at all — so no contact-level blacklist flag to clear.');
  } else if (!contact.ok) {
    line(`  Could not read the contact: ${contact.body?.message || contact.status}`);
  } else {
    line(`  emailBlacklisted: ${contact.body?.emailBlacklisted}`);
    line(`  smsBlacklisted:   ${contact.body?.smsBlacklisted}`);
  }
}

line();
