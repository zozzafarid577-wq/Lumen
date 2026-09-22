import { createClient } from '@supabase/supabase-js';

// The service-role client bypasses row-level security. Everything it does
// must therefore scope itself to a tenant by hand — `assertTenant` in
// _lib/auth.js is what turns that obligation into something checkable.
export const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Used only to turn a caller's access token back into a user. It has the
// same powers as the browser, which is the point: if this client can read
// it, so can anyone holding that token.
export const anon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
