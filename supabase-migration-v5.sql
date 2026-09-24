-- ================================================================
-- Lumen migration v5 — groups, and which one a student attends
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v4. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   A teacher does not teach one class of forty. They teach the same
--   course three times a week to three different sets of students, and
--   until now Lumen had no idea which of those a student belonged to.
--
--   A group belongs to a COURSE, not to a teacher and not to a student.
--   That is what makes "Sara is in the Sunday group for Biology and the
--   Tuesday group for Chemistry" expressible — the group is the class
--   that meets, so it teaches exactly one course at a set time, and the
--   enrolment (which is already one student and one course) is the right
--   place to say which one she attends.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id  UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Which days it meets: 0 = Sunday … 6 = Saturday, matching
  -- JavaScript's getDay() so the browser needs no lookup table. An empty
  -- array is a group whose teacher has not said when it meets yet, which
  -- is allowed — the name alone is already useful.
  days       SMALLINT[] NOT NULL DEFAULT '{}',
  start_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The pair a foreign key can point at, so an enrolment cannot name a
-- group that belongs to a different course. Enforced by the database
-- rather than by whichever page happens to be writing.
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_id_course_key;
ALTER TABLE public.groups ADD CONSTRAINT groups_id_course_key UNIQUE (id, course_id);

ALTER TABLE public.enrollments
  ADD COLUMN IF NOT EXISTS group_id UUID;

-- ON DELETE SET NULL: deleting a group a teacher no longer runs must not
-- unenrol its students. They lose a timetable, not their course.
--
-- The column list is what makes that true, and it is not optional (see
-- v14). Bare SET NULL nulls every column of the key, course_id included,
-- and course_id is NOT NULL — so deleting a group with anyone in it
-- fails with "null value in column course_id". This file shipped without
-- it, which meant re-running v5 after v14 put the bug back; it is
-- corrected here so the order these are replayed in cannot matter.
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_group_fk;
ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id)
  ON DELETE SET NULL (group_id);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "groups_staff_all" ON public.groups;
CREATE POLICY "groups_staff_all" ON public.groups
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- A student reads the groups of a course they are on, so their portal
-- can tell them when their class meets. Nothing here says who else is in
-- it — that is the enrolment table, which a student only ever sees their
-- own rows of.
DROP POLICY IF EXISTS "groups_student_read" ON public.groups;
CREATE POLICY "groups_student_read" ON public.groups
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND NOT public.student_outside_course(course_id)
  );

-- Two groups called "Sunday" on one course make the picker useless. On
-- lower() so "sunday" typed in a hurry is caught as the one that exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_unique_name
  ON public.groups (course_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_groups_course     ON public.groups(teacher_id, course_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_group ON public.enrollments(group_id);
