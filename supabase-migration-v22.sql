-- ================================================================
-- Lumen migration v22 — mock exams, FRQ papers and flashcards
--
-- Safe to run twice. It writes no rows.
--
--   practice_tests.kind  what a paper is, and so which student tab it
--                        sits in: 'practice' (every test so far; on the
--                        course page), 'mock' (Mock tests tab) or 'frq'
--                        (FRQs tab).
--   flashcard_decks      a teacher's deck, filed under a course and, if
--                        they like, a unit and lesson. Students read the
--                        active decks of the courses they are on.
--   flashcards           the cards, front and back. Which ones a student
--                        knows is kept on their device, not here.
-- ================================================================

ALTER TABLE public.practice_tests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'practice';
DO $$ BEGIN
  ALTER TABLE public.practice_tests ADD CONSTRAINT practice_tests_kind_check CHECK (kind IN ('practice', 'mock', 'frq'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.flashcard_decks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id   UUID REFERENCES public.modules(id) ON DELETE SET NULL,
  lesson_id   UUID REFERENCES public.lessons(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.flashcard_decks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "decks_staff_all" ON public.flashcard_decks;
CREATE POLICY "decks_staff_all" ON public.flashcard_decks
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));
DROP POLICY IF EXISTS "decks_student_read" ON public.flashcard_decks;
CREATE POLICY "decks_student_read" ON public.flashcard_decks
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND is_active = true
    AND NOT public.student_outside_course(course_id)
  );

CREATE TABLE IF NOT EXISTS public.flashcards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  deck_id     UUID NOT NULL REFERENCES public.flashcard_decks(id) ON DELETE CASCADE,
  front       TEXT NOT NULL,
  back        TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.flashcards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cards_staff_all" ON public.flashcards;
CREATE POLICY "cards_staff_all" ON public.flashcards
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));
DROP POLICY IF EXISTS "cards_student_read" ON public.flashcards;
CREATE POLICY "cards_student_read" ON public.flashcards
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND EXISTS (
      SELECT 1 FROM public.flashcard_decks d
      WHERE d.id = flashcards.deck_id AND d.is_active = true
        AND NOT public.student_outside_course(d.course_id)
    )
  );
CREATE INDEX IF NOT EXISTS idx_flashcards_deck ON public.flashcards (deck_id, order_index);
