-- ================================================================
-- Lumen migration v11 — batch invite links, and registering only once
--
-- Run this once, in the Supabase SQL Editor, on a project that already
-- has supabase-setup.sql and migrations v1–v10. Every statement here is
-- safe to run twice.
--
-- What changes and why:
--
--   Adding a class of thirty students one form at a time is thirty
--   rounds of typing a name and a phone number a teacher does not have
--   in front of them. A teacher sends one link to the batch's WhatsApp
--   group instead, and each student fills their own details in once.
--
--   "Once" is the whole point, and it is enforced here rather than in
--   the handler: a student who taps Register twice on a slow connection
--   sends two requests that are both past any "have we seen this email"
--   check before either has written a row. A unique index is the only
--   thing that decides such a race, so the two indexes at the bottom of
--   this file are what actually keep one person from registering twice.
--
--   Both keys are per teacher, not global. The same student may sit in
--   two teachers' spaces — they are different schools — but only once
--   in either. A rejected registration is excluded from both indexes,
--   so a teacher who turns away a mistyped entry lets that person try
--   again rather than locking them out for good.
--
--   Nothing here is readable by an anonymous visitor. The public
--   registration page never touches these tables directly; it goes
--   through api/join.js, which holds the service-role key and checks
--   the token itself. So there is deliberately no anon policy below.
-- ================================================================

-- ────────────────────────────────────────
-- INVITE LINKS (one per batch)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invite_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id  UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- The batch itself. Nullable because a teacher may run a course with no
  -- timetable settled yet, and ON DELETE SET NULL below means deleting a
  -- group does not delete the link students may already be holding.
  group_id   UUID,

  -- What goes in the URL. Unique across every tenant, because the public
  -- page has nothing but this to say which space it is registering into.
  token      TEXT NOT NULL UNIQUE,

  -- The teacher's own name for it, shown only to them: "Sat 4pm, Sept
  -- intake". The students see the course and group names instead.
  label      TEXT,

  -- A link that has served its purpose is closed rather than deleted, so
  -- the registrations it brought in keep pointing at something.
  is_open    BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  max_uses   INTEGER CHECK (max_uses IS NULL OR max_uses > 0),

  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The same pairing the enrolments table uses: a group named here has to
  -- belong to the course named here, or the link would enrol its students
  -- into a class that meets for something else.
  -- The column list is load-bearing (see v14): bare SET NULL would null
  -- course_id too, which is NOT NULL, and deleting a group a link points
  -- at would fail instead of forgetting the group.
  CONSTRAINT invite_links_group_fk FOREIGN KEY (group_id, course_id)
    REFERENCES public.groups(id, course_id) ON DELETE SET NULL (group_id)
);

CREATE INDEX IF NOT EXISTS invite_links_teacher_idx
  ON public.invite_links (teacher_id, created_at DESC);

ALTER TABLE public.invite_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invite_links_staff_all" ON public.invite_links;
CREATE POLICY "invite_links_staff_all" ON public.invite_links
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

DROP POLICY IF EXISTS "invite_links_owner_all" ON public.invite_links;
CREATE POLICY "invite_links_owner_all" ON public.invite_links
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- ────────────────────────────────────────
-- STUDENT REGISTRATIONS (what a student filled in)
-- ────────────────────────────────────────
-- A submission is not an account. Nobody can sign in from a row here:
-- the auth user is created when the teacher approves, by the same code
-- path that creates a student typed in by hand. Until then this is a
-- form somebody filled in, and a place on the plan is not used up.
CREATE TABLE IF NOT EXISTS public.student_registrations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,

  -- Where they came from. Both SET NULL rather than CASCADE: a teacher
  -- closing an intake or retiring a course must not quietly erase the
  -- students who were waiting on it.
  invite_id    UUID REFERENCES public.invite_links(id) ON DELETE SET NULL,
  course_id    UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  group_id     UUID REFERENCES public.groups(id) ON DELETE SET NULL,

  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  parent_phone TEXT,
  parent_email TEXT,

  -- The two "this is the same person" keys, generated by the database so
  -- that a handler which forgets to normalise cannot slip a duplicate
  -- past the indexes below.
  --
  -- The phone key is the last 9 digits, which is what makes +201012345678
  -- and 01012345678 the same number. Anything shorter than 7 digits is
  -- not a phone number worth matching on, so it keys as NULL and simply
  -- does not participate.
  email_key    TEXT GENERATED ALWAYS AS (LOWER(BTRIM(email))) STORED,
  phone_key    TEXT GENERATED ALWAYS AS (
    NULLIF(
      CASE WHEN LENGTH(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')) >= 7
           THEN RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 9)
           ELSE '' END,
      '')
  ) STORED,

  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Someone already in this space has this name. Not a block: two real
  -- students share a name often enough that refusing the second one
  -- would turn a common name into a locked door. The teacher sees the
  -- warning and decides.
  name_flag    BOOLEAN NOT NULL DEFAULT false,

  -- The account this became, once approved.
  student_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  review_note  TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS student_registrations_teacher_idx
  ON public.student_registrations (teacher_id, status, submitted_at DESC);

-- ── Register once ────────────────────────────────────────────────
-- The two constraints the whole feature rests on. Partial, so that a
-- rejected row releases the email and the number again.
CREATE UNIQUE INDEX IF NOT EXISTS student_registrations_email_once
  ON public.student_registrations (teacher_id, email_key)
  WHERE status <> 'rejected';

CREATE UNIQUE INDEX IF NOT EXISTS student_registrations_phone_once
  ON public.student_registrations (teacher_id, phone_key)
  WHERE phone_key IS NOT NULL AND status <> 'rejected';

ALTER TABLE public.student_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_registrations_staff_all" ON public.student_registrations;
CREATE POLICY "student_registrations_staff_all" ON public.student_registrations
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

DROP POLICY IF EXISTS "student_registrations_owner_all" ON public.student_registrations;
CREATE POLICY "student_registrations_owner_all" ON public.student_registrations
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());
