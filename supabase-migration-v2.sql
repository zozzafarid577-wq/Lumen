-- ================================================================
-- Lumen migration v2 — tests and bank questions know their section
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and supabase-migration-v1.sql. A fresh project
-- does not need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   A unit and a lesson say WHERE in the course a test sits. They do not
--   say what it asks. A language teacher sets one paper on vocabulary
--   and another on grammar for the very same lesson, and had no way to
--   tell them apart in a list of forty tests.
--
--   Each teacher writes their own list rather than choosing from ours.
--   Lumen is sold to whoever teaches: "Vocabulary" and "Grammar" are the
--   right two for an English teacher and meaningless to a chemistry one,
--   and a fixed set would be a migration every time a teacher wanted a
--   section we had not thought of.
-- ================================================================

-- ── The sections themselves ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.test_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.test_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sections_staff_all" ON public.test_sections;
CREATE POLICY "sections_staff_all" ON public.test_sections
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- Students read them: a test's section is part of how it is labelled in
-- their portal, the same way its title is.
DROP POLICY IF EXISTS "sections_member_read" ON public.test_sections;
CREATE POLICY "sections_member_read" ON public.test_sections
  FOR SELECT USING (public.is_member_of(teacher_id));

-- ── Pointing at them ──────────────────────────────────────────────
ALTER TABLE public.practice_tests
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES public.test_sections(id) ON DELETE SET NULL;

ALTER TABLE public.question_bank
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES public.test_sections(id) ON DELETE SET NULL;

-- ON DELETE SET NULL, like the unit and the lesson before it. Deleting a
-- section a teacher no longer uses must not take forty tests and three
-- hundred questions with it — they lose a label, not their content.

-- ── Indexes ───────────────────────────────────────────────────────
-- Two sections called "Grammar" in one space make the filter useless and
-- the picker baffling. On lower() rather than the column, so "grammar"
-- typed in a hurry is caught as the name that already exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_unique_name
  ON public.test_sections (teacher_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_sections_tenant ON public.test_sections(teacher_id, order_index);
CREATE INDEX IF NOT EXISTS idx_bank_section    ON public.question_bank(teacher_id, section_id);

-- ── Nothing is filled in for you ──────────────────────────────────
-- No starter sections are inserted. "Vocabulary" and "Grammar" are one
-- teacher's list, and a space that opens with somebody else's words
-- already in it reads as a bug. Each teacher adds their own under
-- Settings, and every existing test and question keeps a null section
-- until its teacher says otherwise.
