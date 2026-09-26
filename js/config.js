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
  // The address Lumen is handed out under. Links a teacher sends — an
  // invite link, a student's sign-in details — are built from this
  // rather than from whatever URL the teacher happens to be browsing,
  // so working from the deployment's own long hostname does not send
  // students a link twice the length with a project name in it.
  //
  // Origin only, no trailing slash, no path. Remove it and links fall
  // back to the current origin, which is what used to happen always.
  //
  // The server half of this is the PUBLIC_URL environment variable,
  // read by siteUrlFor() in api/_lib/email.js for the links inside
  // emails. The two should name the same site.
  SITE_URL: 'https://lumenlearn.site',

  // The walkthrough a student can watch from the sign-in page: how to
  // get in, and where the lessons and tests are once they have.
  //
  // A Google Drive file's *preview* URL, not its /view one — /view
  // refuses to be framed, and an iframe pointed at it comes up blank.
  // Take the id out of the sharing link and put it here:
  //   https://drive.google.com/file/d/<id>/preview
  //
  // The file has to be shared as "anyone with the link", or every
  // student meets a Google sign-in box instead of the video. Leave this
  // empty and the button simply does not appear.
  STUDENT_GUIDE_URL: 'https://drive.google.com/file/d/1tQoOSJE7aUduLAp6ULuCVr6g_cWd4HLg/preview',
  SUPABASE_URL: 'https://ivguwplraowoelewroxw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2Z3V3cGxyYW93b2VsZXdyb3h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMDAzOTAsImV4cCI6MjEwNTY3NjM5MH0.gk2qncKT0qU20gpnFvyzvLPrXQetOecyjHDXEDSM15w',
};
