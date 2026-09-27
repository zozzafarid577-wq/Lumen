// A one-off send, for checking that mail actually leaves the building —
// and that an address Brevo has blocklisted is cleared and sent to
// anyway, which is the thing that is hard to believe without seeing.
//
// The key is read from .env.local (git-ignored) or from the
// environment. It is never passed on the command line, where it would
// be kept in a shell history.
//
//   echo 'BREVO_API_KEY=xkeysib-…'        >  .env.local
//   echo 'BREVO_SENDER_EMAIL=you@your.tld' >> .env.local
//   node scripts/send-test-email.mjs someone@example.com
//
// The sender address has to be one Brevo has verified, or every send is
// refused for a reason that has nothing to do with the recipient.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A deliberately small .env reader: KEY=value, one per line, # for a
// comment. Anything cleverer is a dependency for a file with two lines
// in it.
try {
  for (const line of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* no file: fall back to the real environment */ }

const to = process.argv[2];
if (!to) {
  console.error('Usage: node scripts/send-test-email.mjs someone@example.com');
  process.exit(1);
}

const { sendEmail, emailStatus, accountReady } = await import(resolve(ROOT, 'api/_lib/email.js'));

const status = emailStatus();
if (!status.ready) {
  console.error(`Not configured: ${status.why}`);
  console.error('Put BREVO_API_KEY and BREVO_SENDER_EMAIL in .env.local first.');
  process.exit(1);
}

console.log(`Sending to ${to}…`);

// The real template, not a "hello world": a send that works with a
// stripped-down message and fails with the actual one has told you
// nothing.
const out = await sendEmail({
  to,
  toName: 'Test',
  ...accountReady({
    name: 'Test Student',
    email: to,
    password: 'not-a-real-password',
    spaceName: 'Lumen test',
    loginUrl: 'https://lumenlearn.site/login.html',
  }),
});

if (out.sent && out.unblocked) {
  console.log('SENT — and that address was on the blocklist, so it was cleared first.');
} else if (out.sent) {
  console.log('SENT — the address was not blocked.');
} else {
  console.log(`NOT SENT — ${out.error}`);
}
