-- ================================================================
-- Lumen migration v8 — a test can be set to a group with a deadline
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v7. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   A test's own open_at / close_at apply to everybody at once. A
--   teacher running the same course on Sunday and on Tuesday cannot give
--   the Sunday group until Wednesday and the Tuesday group until Friday
--   without building the paper twice.
--
--   Setting a test is now its own row: this test, to this group (or to
--   the whole course), due then. Nothing is typed — a test is picked, a
--   group is picked, a date is picked.
--
--   It ADDS a deadline; it does not gate the test. A test stays visible
--   and startable as it always was, so nothing a teacher has already
--   built disappears from a student's page the moment this is applied.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.test_assignments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  test_id    UUID NOT NULL REFERENCES public.practice_tests(id) ON DELETE CASCADE,
  -- Carried rather than read through the test, because the group it is
  -- paired with has to belong to the same course — the foreign key below
  -- is what enforces that.
  course_id  UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- NULL means the whole course: every student on it, whatever group
  -- they attend, or none.
  group_id   UUID,
  due_at     TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A group from another course cannot be given this course's test. The
-- pair is what groups_id_course_key (migration v5) exists for.
ALTER TABLE public.test_assignments DROP CONSTRAINT IF EXISTS test_assignments_group_fk;
ALTER TABLE public.test_assignments ADD CONSTRAINT test_assignments_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id) ON DELETE CASCADE;

ALTER TABLE public.test_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "test_assignments_staff_all" ON public.test_assignments;
CREATE POLICY "test_assignments_staff_all" ON public.test_assignments
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- A student reads the ones set to them: to their whole course, or to the
-- group they attend on it. Not the ones set to the other group, or they
-- would see a deadline that is not theirs.
DROP POLICY IF EXISTS "test_assignments_student_read" ON public.test_assignments;
CREATE POLICY "test_assignments_student_read" ON public.test_assignments
  FOR SELECT USING (
    public.is_member_of(teacher_id)
    AND NOT public.student_outside_course(course_id)
    AND (
      group_id IS NULL
      OR public.jwt_role() <> 'student'
      OR EXISTS (
        SELECT 1 FROM public.enrollments e
        WHERE e.student_id = auth.uid()
          AND e.course_id = test_assignments.course_id
          AND e.group_id = test_assignments.group_id
      )
    )
  );

-- One deadline per test per group, and one for the whole course. Two
-- partial indexes rather than one, because a NULL group_id does not
-- collide with itself in a plain unique index — which would let the same
-- test be set to the whole course twice, with two different dates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_assignment_group
  ON public.test_assignments (test_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_assignment_course
  ON public.test_assignments (test_id) WHERE group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_test_assignments_course
  ON public.test_assignments (course_id, due_at);
