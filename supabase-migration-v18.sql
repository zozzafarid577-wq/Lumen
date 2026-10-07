-- ================================================================
-- Lumen migration v18 — who teaches each group
--
-- Safe to run twice. It writes no rows.
--
-- A space is often signed into with a shared address ("smartenglish…")
-- that is not the inbox of the teacher who takes a given group. Each
-- group can now name its teacher, and the group's marks report — the
-- morning email and the "Send marks to teacher" button — goes to that
-- teacher. A group with no teacher named keeps going to the space's
-- own teacher account.
-- ================================================================

ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS teacher_name  TEXT;
ALTER TABLE public.groups ADD COLUMN IF NOT EXISTS teacher_email TEXT;
