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
  // A video file this site serves, played by the browser's own player —
  // not an embed from anywhere else. An embedded player brings its own
  // look, its own buttons and, for a recording that is not exactly 16:9,
  // its own black bars.
  //
  // To change the video: put the new file in /assets and name it here.
  // It wants to be an MP4 (H.264) — what every browser and phone plays
  // without being asked twice. Leave this empty and the player does not
  // appear at all.
  STUDENT_GUIDE_URL: '/assets/student-guide.mp4',
  SUPABASE_URL: 'https://ivguwplraowoelewroxw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2Z3V3cGxyYW93b2VsZXdyb3h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMDAzOTAsImV4cCI6MjEwNTY3NjM5MH0.gk2qncKT0qU20gpnFvyzvLPrXQetOecyjHDXEDSM15w',
};
