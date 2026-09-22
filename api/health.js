// Is this deployment configured?
//
// Every other endpoint needs Supabase before it can say anything useful,
// so when the environment is wrong they all fail the same opaque way.
// This one imports nothing and answers on its own.
//
// It reports only whether each variable is SET, never what it contains —
// a public endpoint must not become a way to read the service-role key.
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const OPTIONAL = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'PUBLIC_URL'];

const isSet = (name) => Boolean((process.env[name] || '').trim());

export default function handler(req, res) {
  const missing = REQUIRED.filter(n => !isSet(n));
  const env = {};
  for (const n of [...REQUIRED, ...OPTIONAL]) env[n] = isSet(n);

  // The URL is the one value worth echoing: it is public anyway, it is in
  // js/config.js, and seeing the wrong project here is the fastest way to
  // spot a deployment pointed at the wrong database.
  const url = (process.env.SUPABASE_URL || '').trim();

  return res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    node: process.version,
    supabase_url: url || null,
    email_ready: isSet('BREVO_API_KEY') && isSet('BREVO_SENDER_EMAIL'),
    env,
    missing,
    hint: missing.length
      ? `Set ${missing.join(', ')} in your deployment's environment variables, then redeploy.`
      : 'Configured.',
  });
}
