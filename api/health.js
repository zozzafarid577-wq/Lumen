// Is this deployment configured?
//
// Every other endpoint needs Supabase before it can say anything useful,
// so when the environment is wrong they all fail the same opaque way.
// This one imports nothing and answers on its own.
//
// It reports only whether each variable is SET, never what it contains —
// a public endpoint must not become a way to read the service-role key.
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const OPTIONAL = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_REPLY_TO', 'PUBLIC_URL'];

const isSet = (name) => Boolean((process.env[name] || '').trim());

// Sending as gmail.com, yahoo.com or the like through anybody else is
// the commonest reason a transactional email never arrives, and it
// fails in a way that looks like something else entirely.
//
// Gmail refuses a message claiming to come from @gmail.com that Google
// did not send. Brevo records that refusal as a bounce, a bounce puts
// the recipient on Brevo's blocklist, and the NEXT send is refused with
// "blocked : due to blacklist user" — a message about the recipient,
// for a problem with the sender. Clearing the blocklist only starts the
// loop again.
//
// The fix is a domain you own, authenticated with the provider. Named
// here because this endpoint is where somebody looks when mail is not
// arriving.
const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol)\./i;

function senderWarning() {
  const from = (process.env.BREVO_SENDER_EMAIL || '').trim();
  if (!from || !FREE_MAIL.test(from)) return null;
  return `Mail is sent as ${from}, which is a free mailbox rather than a domain you own. `
    + 'Receivers reject or filter that, the rejection is recorded as a bounce, and the bounce '
    + 'blocklists the recipient — so the next send is refused as "blacklist user". '
    + 'Authenticate your own domain with the mail provider and send as an address on it.';
}

export default async function handler(req, res) {
  // The daily reminder run (vercel.json "crons"). Loaded only when asked
  // for, so the plain health check still imports nothing.
  if (req.query?.task === 'reminders' || req.query?.task === 'group-report') {
    const secret = (process.env.CRON_SECRET || '').trim();
    if (secret && (req.headers?.authorization || '') !== 'Bearer ' + secret) {
      return res.status(401).json({ error: 'Not allowed.' });
    }
    try {
      if (req.query.task === 'group-report') {
        const { runGroupReports } = await import('./_lib/group-report.js');
        return res.status(200).json({ ok: true, ...(await runGroupReports()) });
      }
      const { runReminders } = await import('./_lib/push.js');
      return res.status(200).json({ ok: true, sent: await runReminders() });
    } catch (err) {
      console.error('reminders failed:', err);
      return res.status(500).json({ ok: false });
    }
  }

  const missing = REQUIRED.filter(n => !isSet(n));
  const env = {};
  for (const n of [...REQUIRED, ...OPTIONAL]) env[n] = isSet(n);

  // The URL is the one value worth echoing: it is public anyway, it is in
  // js/config.js, and seeing the wrong project here is the fastest way to
  // spot a deployment pointed at the wrong database.
  const url = (process.env.SUPABASE_URL || '').trim();

  const warn = senderWarning();

  return res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    node: process.version,
    supabase_url: url || null,
    email_ready: isSet('BREVO_API_KEY') && isSet('BREVO_SENDER_EMAIL'),
    // Named, not hidden: this is the one setting that makes mail vanish
    // while every other check says the deployment is fine.
    email_warning: warn,
    env,
    missing,
    hint: missing.length
      ? `Set ${missing.join(', ')} in your deployment's environment variables, then redeploy.`
      : 'Configured.',
  });
}
