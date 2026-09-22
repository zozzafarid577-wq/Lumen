// ─────────────────────────────────────────────────────────────────
// Lumen — front-end configuration
//
// These come from Supabase Dashboard → Project Settings → API.
//
// The anon key is meant to be public — it is served inside every page
// the browser loads, so it is public whatever this repository's
// visibility. What keeps one teacher's students out of another
// teacher's data is row-level security (supabase-setup.sql), not the
// secrecy of this key. If those policies are ever dropped, this key
// reads everything.
//
// The service-role key must NEVER appear in this file. It bypasses
// row-level security entirely, which would expose every tenant at once.
// It belongs only in the deployment's environment variables, where the
// handlers in api/ read it.
// ─────────────────────────────────────────────────────────────────
window.LUMEN_CONFIG = {
  SUPABASE_URL: 'https://ivguwplraowoelewroxw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2Z3V3cGxyYW93b2VsZXdyb3h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMDAzOTAsImV4cCI6MjEwNTY3NjM5MH0.gk2qncKT0qU20gpnFvyzvLPrXQetOecyjHDXEDSM15w',
};
