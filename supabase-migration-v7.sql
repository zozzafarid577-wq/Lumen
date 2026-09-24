-- ================================================================
-- Lumen migration v7 — sections carry a colour, tests carry an order
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v6. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   1. A section is a label — Vocabulary, Grammar, Listening — and every
--      one of them was drawn in the same brand purple. On a unit with
--      four papers the labels were the only thing telling them apart,
--      and they all looked identical. Each section now carries its own
--      colour, chosen by the teacher and shown to students too.
--
--   2. Tests came back in the order they happened to be created. A
--      teacher who builds Part 2 before Part 1 had no way to swap them,
--      so they now carry an order_index like units and lessons, and are
--      dragged into place on the course page.
-- ================================================================

-- ── 1. A colour per section ───────────────────────────────────────
-- Stored as a #rrggbb string and checked, because it is written
-- straight into a style attribute: anything that is not a plain hex
-- colour has no business being there.
ALTER TABLE public.test_sections
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#A2509F';

ALTER TABLE public.test_sections DROP CONSTRAINT IF EXISTS test_sections_color_hex;
ALTER TABLE public.test_sections ADD CONSTRAINT test_sections_color_hex
  CHECK (color ~* '^#[0-9a-f]{6}$');

-- ── 2. An order per test ──────────────────────────────────────────
-- Ties fall back to oldest-first, which is the order they were built
-- in — so a space that never reorders looks exactly as it did.
ALTER TABLE public.practice_tests
  ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tests_order
  ON public.practice_tests (course_id, order_index);
