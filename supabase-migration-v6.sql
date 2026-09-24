-- ================================================================
-- Lumen migration v6 — a teacher can order their courses
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v5. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   Units and lessons have always carried an order_index, so a teacher
--   could put them in the order they teach them. Courses could not: they
--   came back newest-first, which is the order they happened to be
--   created in and not an order anyone chose.
--
--   Everything defaults to 0, and the list falls back to newest-first
--   when the indexes tie — so a space that never touches this looks
--   exactly as it did, and one drag is enough to start ordering.
-- ================================================================

ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_courses_order
  ON public.courses (teacher_id, order_index);
