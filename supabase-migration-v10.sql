-- ================================================================
-- Lumen migration v10 — a "how to use this" video for the students
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v9. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   Students arriving at their courses page for the first time have to
--   work out what a unit is, where the handouts are and what "Practise"
--   does. A teacher explaining that once, on video, saves them
--   explaining it to every student in the class one at a time.
--
--   One video per space rather than per course: it is about how the
--   page works, which does not change between a teacher's courses. The
--   panel only appears on the student's page once this is filled in, so
--   a teacher who does not want one simply leaves it empty.
-- ================================================================

ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS intro_video_url TEXT;
