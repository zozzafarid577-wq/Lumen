// ─────────────────────────────────────────────────────────────────
// Lumen — front-end configuration
//
// SETUP: put your Supabase project's values here.
//   Supabase Dashboard → Project Settings → API
//
// The anon key is meant to be public — it is in every page the browser
// loads. What keeps one teacher's students out of another teacher's data
// is row-level security (supabase-setup.sql), not the secrecy of this key.
// The service-role key must NEVER appear in this file; it belongs only in
// the Vercel environment variables that api/ reads.
// ─────────────────────────────────────────────────────────────────
window.LUMEN_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',

  // Shown on the marketing site and in the emails/messages the portal
  // composes. Nothing here affects access control.
  BRAND: {
    name: 'Lumen',
    tagline: 'Educate with Excellence',
    email: 'hello@lumen.education',
    whatsapp: '',           // digits only, e.g. '201114425101'
  },
};
