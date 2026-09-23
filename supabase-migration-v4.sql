-- ================================================================
-- Lumen migration v4 — a student can ask for help
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v3. A fresh project does not
-- need it. Every statement here is safe to run twice.
--
-- What changes and why:
--
--   A student who cannot open a PDF, or whose test will not load, has
--   had nowhere to say so. They are children in someone else's software:
--   they will not email, and they should not have to find their
--   teacher's phone number to report that a page is broken.
--
--   The Lumen character in the corner of their portal is the way in, and
--   this is where what they write lands. A row, not an email: an email
--   depends on a mail provider being configured and having a good
--   afternoon, and a request that vanishes is worse than no button at
--   all. The teacher sees open requests on their own dashboard.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.support_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  -- Kept as a plain column as well as a reference: a student who leaves
  -- the space should not take the unanswered question with them.
  student_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  email      TEXT,
  kind       TEXT NOT NULL DEFAULT 'other'
             CHECK (kind IN ('technical', 'course', 'other')),
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.support_requests ENABLE ROW LEVEL SECURITY;

-- The teacher and their assistants see everything in their own space and
-- are the ones who close a request.
DROP POLICY IF EXISTS "support_staff_all" ON public.support_requests;
CREATE POLICY "support_staff_all" ON public.support_requests
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- A student writes their own, into their own teacher's space. Both
-- halves matter: without the student_id check one student could file a
-- request as another, and without is_member_of they could file into
-- another teacher's inbox.
DROP POLICY IF EXISTS "support_student_write" ON public.support_requests;
CREATE POLICY "support_student_write" ON public.support_requests
  FOR INSERT WITH CHECK (public.is_member_of(teacher_id) AND student_id = auth.uid());

-- And reads back only their own, so they can see it was received.
DROP POLICY IF EXISTS "support_student_read" ON public.support_requests;
CREATE POLICY "support_student_read" ON public.support_requests
  FOR SELECT USING (student_id = auth.uid());

-- Deliberately no student UPDATE or DELETE policy: closing a request is
-- the teacher's word on it, and a student cannot withdraw a report of a
-- problem that may still be real for everyone else.

CREATE INDEX IF NOT EXISTS idx_support_open
  ON public.support_requests (teacher_id, created_at DESC)
  WHERE status = 'open';
