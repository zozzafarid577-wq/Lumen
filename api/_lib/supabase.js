import { createClient } from '@supabase/supabase-js';

// Both clients are built on first use, not at import.
//
// supabase-js throws "supabaseUrl is required" when it is handed an
// undefined URL. Doing that at module scope kills the function before the
// handler exists, and the platform answers with its own opaque
// FUNCTION_INVOCATION_FAILED — which says nothing about which variable is
// missing. Deferring it means the failure happens inside handler(), which
// turns it into a sentence naming the variable.
//
// /api/health reports which of them are set without needing either client.
function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    const err = new Error(`Lumen is not configured: ${name} is not set on this deployment.`);
    err.status = 503;
    throw err;
  }
  return value;
}

// A stand-in that builds the real client the first time anything is read
// off it, so `admin.from(...)` at every call site keeps working unchanged.
function lazyClient(build) {
  let client = null;
  return new Proxy({}, {
    get(_target, prop) {
      if (!client) client = build();
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}

const options = { auth: { autoRefreshToken: false, persistSession: false } };

// The service-role client bypasses row-level security. Everything it does
// must therefore scope itself to a tenant by hand — `assertTenant` in
// _lib/auth.js is what turns that obligation into something checkable.
export const admin = lazyClient(() =>
  createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), options));

// Used only to turn a caller's access token back into a user. It has the
// same powers as the browser, which is the point: if this client can read
// it, so can anyone holding that token.
export const anon = lazyClient(() =>
  createClient(required('SUPABASE_URL'), required('SUPABASE_ANON_KEY'), options));
