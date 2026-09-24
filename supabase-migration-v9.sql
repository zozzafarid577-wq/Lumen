-- ================================================================
-- Lumen migration v9 — a parent hears the result
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v8. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   When a student finishes a test, the mark goes to their parent by
--   email. A parent who hears "it went fine" three weeks later cannot do
--   anything with that; one who hears 48% on the day can.
--
--   This column is what stops the same result being sent twice. The
--   attempt is written by the browser, so the email is asked for by the
--   browser too — and a page that is refreshed, or a retry after a
--   dropped connection, would otherwise send again. The stamp is set by
--   the server, which is the only thing that may write it.
-- ================================================================

ALTER TABLE public.test_attempts
  ADD COLUMN IF NOT EXISTS parent_emailed_at TIMESTAMPTZ;

-- The lookup api/result-email.js makes: this student's newest finished
-- attempt at this test that nobody has been told about yet.
CREATE INDEX IF NOT EXISTS idx_attempts_unsent
  ON public.test_attempts (student_id, test_id, completed_at DESC)
  WHERE parent_emailed_at IS NULL;
