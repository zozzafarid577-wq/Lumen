-- ================================================================
-- Lumen — Educate with Excellence
-- Multi-tenant educational dashboard platform.
--
-- Run this entire file once in your Supabase SQL Editor, then each
-- supabase-migration-vN.sql in order.
--
-- THE TENANT MODEL
-- ----------------
-- Every teacher who subscribes to Lumen is one row in `teachers`, and
-- every piece of content — courses, lessons, tests, students — carries
-- that teacher's id. Nothing is shared between teachers.
--
-- Isolation is enforced by row-level security reading two claims out of
-- the JWT: `role` and `teacher_id`. Both are written into the user's
-- app_metadata by the server-side API (which holds the service-role key)
-- when the account is created, so a signed-in user cannot change their
-- own tenant or promote themselves. Reading them from the token instead
-- of from `profiles` also keeps the policies free of the recursive
-- profile lookup that makes RLS on a profiles table so easy to get wrong.
-- ================================================================

-- ────────────────────────────────────────
-- CLAIM HELPERS
-- ────────────────────────────────────────
-- 'owner' (Lumen staff) | 'teacher' | 'assistant' | 'student'
CREATE OR REPLACE FUNCTION public.jwt_role() RETURNS TEXT
  LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

CREATE OR REPLACE FUNCTION public.jwt_teacher_id() RETURNS UUID
  LANGUAGE SQL STABLE AS $$
  SELECT NULLIF(auth.jwt() -> 'app_metadata' ->> 'teacher_id', '')::UUID
$$;

-- Lumen's own staff. Sees across every tenant; there are very few of them.
CREATE OR REPLACE FUNCTION public.is_platform_owner() RETURNS BOOLEAN
  LANGUAGE SQL STABLE AS $$
  SELECT public.jwt_role() = 'owner'
$$;

-- The teacher who owns this tenant, or an assistant they hired. These two
-- share the management portal; assistants are narrowed by `staff_perms`
-- in the UI and by the API, not by separate policies.
CREATE OR REPLACE FUNCTION public.is_staff_of(t UUID) RETURNS BOOLEAN
  LANGUAGE SQL STABLE AS $$
  SELECT t IS NOT NULL
     AND public.jwt_teacher_id() = t
     AND public.jwt_role() IN ('teacher', 'assistant')
$$;

-- Anyone signed in who belongs to this tenant, students included.
CREATE OR REPLACE FUNCTION public.is_member_of(t UUID) RETURNS BOOLEAN
  LANGUAGE SQL STABLE AS $$
  SELECT t IS NOT NULL AND public.jwt_teacher_id() = t
$$;

-- One more helper, public.student_outside_course(), narrows the content
-- policies by enrolment. It reads the `enrollments` table, and a
-- SQL-language function has its body checked when it is created — so it
-- is defined further down, right after that table exists, rather than
-- here with the rest.

-- ────────────────────────────────────────
-- TEACHERS (the tenant)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.teachers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Used in URLs and in the student's sign-in hint. No separate domain is
  -- sold, so this is how a teacher's space is named inside Lumen.
  slug           TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  subject        TEXT,
  tagline        TEXT,
  bio            TEXT,
  logo_url       TEXT,
  brand_color    TEXT NOT NULL DEFAULT '#A2509F',
  contact_email  TEXT,
  contact_phone  TEXT,
  whatsapp       TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teachers_owner_all" ON public.teachers
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- Everyone in the tenant can read it (the student portal shows the
-- teacher's name and brand); only the teacher can change it.
CREATE POLICY "teachers_member_read" ON public.teachers
  FOR SELECT USING (public.is_member_of(id));

CREATE POLICY "teachers_self_update" ON public.teachers
  FOR UPDATE USING (public.jwt_teacher_id() = id AND public.jwt_role() = 'teacher')
  WITH CHECK (public.jwt_teacher_id() = id AND public.jwt_role() = 'teacher');

-- ────────────────────────────────────────
-- PLANS (the price list on the marketing site)
-- ────────────────────────────────────────
-- The service sheet quotes two things that both live here: the two
-- headline packages (what we do for you) and the student tiers (what it
-- costs at each class size). `listing` is which of the two a row belongs
-- to, so the site can lay them out as the sheet does; both kinds can be
-- put on a subscription.
CREATE TABLE IF NOT EXISTS public.plans (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  listing         TEXT NOT NULL DEFAULT 'package' CHECK (listing IN ('package', 'tier')),
  -- 'basic' = platform management, 'full' = platform + student support
  package         TEXT NOT NULL CHECK (package IN ('basic', 'full')),
  monthly_fee_egp INTEGER NOT NULL,
  setup_fee_egp   INTEGER NOT NULL DEFAULT 0,
  student_limit   INTEGER NOT NULL,
  blurb           TEXT,
  features        JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

-- The price list is public: the marketing site reads it with the anon key
-- so a price change never means editing HTML.
CREATE POLICY "plans_public_read" ON public.plans
  FOR SELECT USING (is_active = true);

CREATE POLICY "plans_owner_all" ON public.plans
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

INSERT INTO public.plans (code, name, listing, package, monthly_fee_egp, setup_fee_egp, student_limit, blurb, features, sort_order)
VALUES
  ('basic-60', 'Platform Management', 'package', 'basic', 5000, 10000, 60,
   'Best for teachers who mainly need the platform managed.',
   '["Dashboard management","Student enrollment & database","Content uploading & organization","Progress tracking","Reports","Technical support","Up to 60 students"]'::jsonb, 10),
  ('full-60', 'Platform + Student Support', 'package', 'full', 8000, 10000, 60,
   'Best for teachers who want ongoing student support and full management.',
   '["Everything in Platform Management","Student support","Answering subject questions","Monitoring student progress","Session support","More active involvement in the educational process"]'::jsonb, 20),
  -- Student tiers: the same full service, priced by class size.
  ('tier-60',  'Up to 60 students',   'tier', 'full',  6000, 10000,  60, NULL, '[]'::jsonb, 110),
  ('tier-100', 'Up to 100 students',  'tier', 'full',  8000, 10000, 100, NULL, '[]'::jsonb, 120),
  ('tier-150', 'Up to 150 students',  'tier', 'full', 10000, 10000, 150, NULL, '[]'::jsonb, 130)
ON CONFLICT (code) DO NOTHING;

-- ────────────────────────────────────────
-- SUBSCRIPTIONS
-- ────────────────────────────────────────
-- The plan's limit and fee are copied onto the subscription rather than
-- read through `plans`, so re-pricing the catalogue never silently changes
-- what an existing teacher agreed to — or how many students they may keep.
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id           UUID NOT NULL UNIQUE REFERENCES public.teachers(id) ON DELETE CASCADE,
  plan_code            TEXT REFERENCES public.plans(code),
  status               TEXT NOT NULL DEFAULT 'trial'
                         CHECK (status IN ('trial', 'active', 'past_due', 'paused', 'cancelled')),
  student_limit        INTEGER NOT NULL DEFAULT 20,
  monthly_fee_egp      INTEGER NOT NULL DEFAULT 0,
  setup_fee_egp        INTEGER NOT NULL DEFAULT 0,
  setup_fee_paid       BOOLEAN NOT NULL DEFAULT false,
  trial_ends_at        TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subs_owner_all" ON public.subscriptions
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- A teacher may read their own subscription but never write it — the plan
-- and the student limit are the commercial agreement, changed by Lumen.
CREATE POLICY "subs_staff_read" ON public.subscriptions
  FOR SELECT USING (public.is_staff_of(teacher_id));

-- ────────────────────────────────────────
-- INVOICES
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('setup', 'monthly', 'adjustment')),
  amount_egp   INTEGER NOT NULL,
  description  TEXT,
  period_start DATE,
  period_end   DATE,
  status       TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'void')),
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at      TIMESTAMPTZ,
  reference    TEXT
);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoices_owner_all" ON public.invoices
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

CREATE POLICY "invoices_staff_read" ON public.invoices
  FOR SELECT USING (public.is_staff_of(teacher_id));

-- ────────────────────────────────────────
-- PROFILES (extends auth.users)
-- ────────────────────────────────────────
-- teacher_id is NULL only for Lumen's own staff.
CREATE TABLE IF NOT EXISTS public.profiles (
  id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  teacher_id     UUID REFERENCES public.teachers(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('owner', 'teacher', 'assistant', 'student')),
  full_name      TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  parent_phone   TEXT,
  parent_email   TEXT,
  -- Which management pages an assistant may open. NULL on a teacher's own
  -- row, which always has every permission.
  staff_perms    TEXT[],
  is_active      BOOLEAN NOT NULL DEFAULT true,
  must_change_pw BOOLEAN NOT NULL DEFAULT true,
  session_token  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT profiles_tenant_required
    CHECK (role = 'owner' OR teacher_id IS NOT NULL)
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_self_select" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- A student may edit their own name and phone. Role, tenant and the active
-- flag are guarded by the trigger below, not by this policy, because
-- WITH CHECK cannot see the row as it was.
CREATE POLICY "profiles_self_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_staff_all" ON public.profiles
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

CREATE POLICY "profiles_owner_all" ON public.profiles
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- Nobody edits their own way into another tenant, or into another role.
--
-- The service-role key used by api/ bypasses RLS but not triggers, so this
-- covers that route too. No handler in api/ changes either column on an
-- existing profile: a role or a tenant is decided when the account is
-- created and does not move afterwards. Should that ever need to change,
-- `SET LOCAL lumen.admin_write = 'on'` inside the transaction is the
-- deliberate, greppable way past it.
CREATE OR REPLACE FUNCTION public.guard_profile_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('lumen.admin_write', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.teacher_id IS DISTINCT FROM OLD.teacher_id THEN
    RAISE EXCEPTION 'role and teacher_id may only be changed by Lumen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS profiles_guard_identity ON public.profiles;
CREATE TRIGGER profiles_guard_identity
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_identity();

-- ────────────────────────────────────────
-- COURSES
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.courses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  subject       TEXT,
  description   TEXT,
  thumbnail_url TEXT,
  exam_date     DATE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  -- The order the teacher dragged them into. Ties fall back to
  -- newest-first, so a space that never reorders looks unchanged.
  order_index   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "courses_staff_all" ON public.courses
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- courses_student_read needs student_outside_course(), which needs the
-- enrollments table — both are just below.

-- ────────────────────────────────────────
-- ENROLLMENTS
-- ────────────────────────────────────────
-- Out of alphabetical order on purpose: every content policy from here
-- down is narrowed by enrolment, so this table and the function that
-- reads it have to exist before any of them are written.
CREATE TABLE IF NOT EXISTS public.enrollments (
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- Which sitting of this course they attend. The foreign key is on the
  -- pair (group_id, course_id), so an enrolment cannot name a group that
  -- belongs to a different course — see the groups table below.
  group_id    UUID,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  PRIMARY KEY (student_id, course_id)
);

ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "enrollments_staff_all" ON public.enrollments
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

CREATE POLICY "enrollments_own_read" ON public.enrollments
  FOR SELECT USING (auth.uid() = student_id);

-- Is the caller a student who is NOT on this course? Used to narrow the
-- content policies: staff see everything in their space, a student sees
-- only the courses they are enrolled on. Phrased as the exclusion so the
-- policies below read as "…AND NOT locked out of this course".
--
-- It reads `enrollments`, whose own policy lets a student see their own
-- rows, so no elevated privilege is needed here.
CREATE OR REPLACE FUNCTION public.student_outside_course(c UUID) RETURNS BOOLEAN
  LANGUAGE SQL STABLE AS $$
  SELECT public.jwt_role() = 'student'
     AND NOT EXISTS (
       SELECT 1 FROM public.enrollments e
       WHERE e.course_id = c AND e.student_id = auth.uid()
     )
$$;

CREATE POLICY "courses_student_read" ON public.courses
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND is_active = true
    AND NOT public.student_outside_course(id)
  );

-- ────────────────────────────────────────
-- GROUPS (the sittings of a course)
-- ────────────────────────────────────────
-- A teacher does not teach one class of forty; they teach the same
-- course three times a week to three different sets of students. A group
-- belongs to a COURSE rather than to a teacher, which is what makes
-- "Sara is in the Sunday group for Biology and the Tuesday group for
-- Chemistry" expressible: the group is the class that meets, so it
-- teaches exactly one course at a set time.
--
-- Below enrollments because the student policy is narrowed by enrolment,
-- and after courses because it points at one.
CREATE TABLE IF NOT EXISTS public.groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id  UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- 0 = Sunday … 6 = Saturday, matching JavaScript's getDay() so the
  -- browser needs no lookup table. Empty is allowed: the name alone is
  -- already useful before a timetable is settled.
  days       SMALLINT[] NOT NULL DEFAULT '{}',
  start_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT groups_id_course_key UNIQUE (id, course_id)
);

-- ON DELETE SET NULL: deleting a group a teacher no longer runs must not
-- unenrol its students. They lose a timetable, not their course.
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_group_fk;
ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id) ON DELETE SET NULL;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "groups_staff_all" ON public.groups
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- A student reads the groups of a course they are on, so their portal can
-- tell them when their class meets. Nothing here says who else is in it —
-- that is `enrollments`, which a student only sees their own rows of.
CREATE POLICY "groups_student_read" ON public.groups
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND NOT public.student_outside_course(course_id)
  );

-- ────────────────────────────────────────
-- MODULES (units inside a course)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  -- A unit is visible to students only once it is marked done AND its
  -- release time has passed. Both halves matter: "done" is the teacher
  -- saying it is ready, `open_at` is the schedule saying it is time.
  is_done     BOOLEAN NOT NULL DEFAULT false,
  open_at     TIMESTAMPTZ,
  order_index INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "modules_staff_all" ON public.modules
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- A draft unit is not just locked, it is invisible: a student should not
-- learn next term's chapter titles from a unit their teacher has not
-- finished writing. Once it is marked done or given a release time, its
-- title shows (as a locked card) while its contents stay shut.
CREATE POLICY "modules_student_read" ON public.modules
  FOR SELECT USING (
    public.is_member_of(teacher_id)
    AND NOT public.student_outside_course(course_id)
    AND (public.jwt_role() <> 'student' OR is_done = true OR open_at IS NOT NULL)
  );

-- ────────────────────────────────────────
-- LESSONS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lessons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  module_id    UUID NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  video_url    TEXT,
  duration_min INTEGER,
  order_index  INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lessons_staff_all" ON public.lessons
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- The release schedule is enforced here, not only in the page that draws
-- the lock icon: a student who opens the network tab still cannot fetch a
-- lesson that has not been released.
-- A lesson is readable through its unit, so the unit's own policy
-- (enrolment, draft, release time) applies here as well as the release
-- check spelled out below.
CREATE POLICY "lessons_student_read" ON public.lessons
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND (
      public.jwt_role() <> 'student' OR EXISTS (
        SELECT 1 FROM public.modules m
        WHERE m.id = lessons.module_id
          AND m.is_done = true
          AND (m.open_at IS NULL OR m.open_at <= NOW())
          AND NOT public.student_outside_course(m.course_id)
      )
    )
  );

-- ────────────────────────────────────────
-- LESSON MATERIALS (PDFs, sheets, links)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lesson_materials (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  lesson_id  UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'pdf' CHECK (kind IN ('pdf', 'link', 'sheet', 'recording')),
  file_url   TEXT NOT NULL,
  file_size  BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.lesson_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "materials_staff_all" ON public.lesson_materials
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

CREATE POLICY "materials_student_read" ON public.lesson_materials
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND (
      public.jwt_role() <> 'student' OR EXISTS (
        SELECT 1 FROM public.lessons l JOIN public.modules m ON m.id = l.module_id
        WHERE l.id = lesson_materials.lesson_id
          AND m.is_done = true
          AND (m.open_at IS NULL OR m.open_at <= NOW())
          AND NOT public.student_outside_course(m.course_id)
      )
    )
  );

-- ────────────────────────────────────────
-- LESSON COMPLETIONS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lesson_completions (
  teacher_id   UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  student_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lesson_id    UUID NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, lesson_id)
);

ALTER TABLE public.lesson_completions ENABLE ROW LEVEL SECURITY;

-- The tenant on the row has to be the writer's own. Without that half, a
-- student could stamp another teacher's id onto their own work and turn
-- up in that teacher's reports.
CREATE POLICY "completions_own_all" ON public.lesson_completions
  FOR ALL USING (auth.uid() = student_id)
  WITH CHECK (auth.uid() = student_id AND public.is_member_of(teacher_id));

CREATE POLICY "completions_staff_read" ON public.lesson_completions
  FOR SELECT USING (public.is_staff_of(teacher_id));

-- ────────────────────────────────────────
-- TEST SECTIONS (what kind of test this is)
-- ────────────────────────────────────────
-- A unit and a lesson say *where* in the course a test sits. They do not
-- say what it asks. A language teacher sets one paper on vocabulary and
-- another on grammar for the very same lesson, and needs to tell them
-- apart in a list of forty tests.
--
-- Each teacher writes their own list rather than choosing from ours.
-- Lumen is sold to whoever teaches: "Vocabulary" and "Grammar" are the
-- right two for an English teacher and meaningless to a chemistry one,
-- and a fixed set would be a migration every time a teacher wanted a
-- section we had not thought of.
CREATE TABLE IF NOT EXISTS public.test_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Drawn into a style attribute, so it is checked here: anything that
  -- is not a plain hex colour has no business being there. Four papers
  -- on one unit are told apart by these labels, and labels that are all
  -- the same purple tell nothing apart.
  color       TEXT NOT NULL DEFAULT '#A2509F' CHECK (color ~* '^#[0-9a-f]{6}$'),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.test_sections ENABLE ROW LEVEL SECURITY;

-- Two sections called "Grammar" in one space make the filter useless and
-- the picker baffling. On lower() rather than the column, so "grammar"
-- typed in a hurry is caught as the name that already exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_unique_name
  ON public.test_sections (teacher_id, lower(name));

CREATE POLICY "sections_staff_all" ON public.test_sections
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- Students read them: a test's section is part of how it is labelled in
-- their portal, the same way its title is.
CREATE POLICY "sections_member_read" ON public.test_sections
  FOR SELECT USING (public.is_member_of(teacher_id));

-- ────────────────────────────────────────
-- QUESTION BANK
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.question_bank (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id     UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  -- Where in the course this question belongs. Both are optional and
  -- both survive their target being deleted, because a question outlives
  -- the unit it was first written for — it is still a good question when
  -- next year's units are rebuilt.
  module_id     UUID REFERENCES public.modules(id) ON DELETE SET NULL,
  lesson_id     UUID REFERENCES public.lessons(id) ON DELETE SET NULL,
  -- What the question asks, as opposed to where it sits: vocabulary,
  -- grammar, whatever this teacher's list holds.
  section_id    UUID REFERENCES public.test_sections(id) ON DELETE SET NULL,
  topic         TEXT,
  question_text TEXT NOT NULL,
  -- [{ "text": "...", "correct": true }, …]
  options       JSONB NOT NULL,
  explanation   TEXT,
  difficulty    TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  image_url     TEXT,
  is_published  BOOLEAN NOT NULL DEFAULT true,
  -- May a student meet this question in practice? Practice shows the
  -- answer once they have had their go, and tests are built by copying
  -- bank rows — so a question being saved for the paper is held back
  -- here, or it is rehearsed before the exam it was written for.
  -- Default true: holding one back is the deliberate act, not the norm.
  practice_ok   BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Saving a test files its questions into the bank, and a teacher who
  -- picks the same question onto three tests must not end up with three
  -- copies of it. Comparing 2000-character texts over the wire is what
  -- this avoids: the server hashes what it is about to file and asks
  -- which hashes are already here.
  --
  -- Deliberately exact rather than lower(btrim(...)): the hash has to be
  -- reproducible character-for-character in JavaScript, and case folding
  -- is the one operation the two languages do not agree on.
  text_key      TEXT GENERATED ALWAYS AS (md5(question_text)) STORED
);

ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bank_staff_all" ON public.question_bank
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- Deliberately no student policy. Every bank row carries which option is
-- correct, and a test is built by copying rows out of the bank — so a
-- student who could read it would have the answers to every test their
-- teacher has set or is about to set. Students only ever see the copies
-- inside `test_questions`, and only once the test has opened.
--
-- Practice is the one exception and it does not change that: it goes
-- through api/practice.js, which holds the service-role key, strips
-- `correct` off every option before sending, and marks each answer
-- server-side. This table stays closed to the browser either way.

-- ────────────────────────────────────────
-- PRACTICE TESTS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.practice_tests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id        UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id         UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id         UUID REFERENCES public.modules(id) ON DELETE SET NULL,
  -- Narrower than the unit: "the quiz that goes with lesson 3" rather
  -- than "a Unit 2 quiz". Set only alongside a module_id — the API
  -- refuses a lesson that is not in the unit chosen with it.
  lesson_id         UUID REFERENCES public.lessons(id) ON DELETE SET NULL,
  -- Which of the teacher's sections this paper is: two tests on the same
  -- lesson are told apart by this and nothing else.
  section_id        UUID REFERENCES public.test_sections(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  time_limit_min    INTEGER,
  passing_score_pct INTEGER NOT NULL DEFAULT 60,
  max_attempts      INTEGER,
  open_at           TIMESTAMPTZ,
  close_at          TIMESTAMPTZ,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  -- The order the teacher dragged them into. Ties fall back to the
  -- order they were built in.
  order_index       INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.practice_tests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tests_staff_all" ON public.practice_tests
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

CREATE POLICY "tests_student_read" ON public.practice_tests
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND is_active = true
    AND NOT public.student_outside_course(course_id)
  );

-- ────────────────────────────────────────
-- TEST QUESTIONS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.test_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  test_id       UUID NOT NULL REFERENCES public.practice_tests(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  options       JSONB NOT NULL,
  explanation   TEXT,
  image_url     TEXT,
  order_index   INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE public.test_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "test_questions_staff_all" ON public.test_questions
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- A scheduled test's questions are unreadable until it opens. Without this
-- the open/close window is only a label on a button.
CREATE POLICY "test_questions_student_read" ON public.test_questions
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND (
      public.jwt_role() <> 'student' OR EXISTS (
        SELECT 1 FROM public.practice_tests t
        WHERE t.id = test_questions.test_id
          AND t.is_active = true
          AND (t.open_at IS NULL OR t.open_at <= NOW())
          AND NOT public.student_outside_course(t.course_id)
      )
    )
  );

-- ────────────────────────────────────────
-- TEST ATTEMPTS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.test_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id     UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  student_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  test_id        UUID NOT NULL REFERENCES public.practice_tests(id) ON DELETE CASCADE,
  answers        JSONB,
  score          INTEGER,
  max_score      INTEGER,
  percentage     DECIMAL(5,2),
  passed         BOOLEAN,
  time_taken_sec INTEGER,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

ALTER TABLE public.test_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attempts_own_all" ON public.test_attempts
  FOR ALL USING (auth.uid() = student_id)
  WITH CHECK (auth.uid() = student_id AND public.is_member_of(teacher_id));

CREATE POLICY "attempts_staff_all" ON public.test_attempts
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- ────────────────────────────────────────
-- TEST ASSIGNMENTS (a test set to a group, with a deadline)
-- ────────────────────────────────────────
-- A test's own open_at / close_at apply to everybody at once. A teacher
-- running the same course on Sunday and on Tuesday cannot give the two
-- groups different deadlines without building the paper twice. Setting a
-- test is its own row: this test, to this group (or to the whole
-- course), due then.
--
-- It ADDS a deadline; it does not gate the test. Whether a student can
-- open the questions is still the test's own window.
CREATE TABLE IF NOT EXISTS public.test_assignments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  test_id    UUID NOT NULL REFERENCES public.practice_tests(id) ON DELETE CASCADE,
  -- Carried rather than read through the test, so the group it is paired
  -- with can be checked against the same course by a foreign key.
  course_id  UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- NULL means the whole course.
  group_id   UUID,
  due_at     TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT test_assignments_group_fk
    FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id) ON DELETE CASCADE
);

ALTER TABLE public.test_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "test_assignments_staff_all" ON public.test_assignments
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- Set to their whole course, or to the group they attend on it — not to
-- the other group, or they would see a deadline that is not theirs.
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

-- ────────────────────────────────────────
-- ASSIGNMENTS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  course_id   UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id   UUID REFERENCES public.modules(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  file_url    TEXT,
  due_at      TIMESTAMPTZ,
  max_score   INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assignments_staff_all" ON public.assignments
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

CREATE POLICY "assignments_student_read" ON public.assignments
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND is_active = true
    AND NOT public.student_outside_course(course_id)
  );

-- ────────────────────────────────────────
-- ASSIGNMENT SUBMISSIONS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assignment_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  file_url      TEXT,
  text_answer   TEXT,
  score         INTEGER,
  feedback      TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  graded_at     TIMESTAMPTZ,
  UNIQUE (assignment_id, student_id)
);

ALTER TABLE public.assignment_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "submissions_own_all" ON public.assignment_submissions
  FOR ALL USING (auth.uid() = student_id)
  WITH CHECK (auth.uid() = student_id AND public.is_member_of(teacher_id));

CREATE POLICY "submissions_staff_all" ON public.assignment_submissions
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- ────────────────────────────────────────
-- ANNOUNCEMENTS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.announcements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  course_id  UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  priority   TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "announcements_staff_all" ON public.announcements
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- An announcement aimed at one course reaches that course's students
-- only; one with no course reaches the whole space.
CREATE POLICY "announcements_student_read" ON public.announcements
  FOR SELECT USING (
    public.is_member_of(teacher_id) AND is_active = true AND (
      course_id IS NULL
      OR public.jwt_role() <> 'student'
      OR EXISTS (
        SELECT 1 FROM public.enrollments e
        WHERE e.course_id = announcements.course_id AND e.student_id = auth.uid()
      )
    )
  );

-- ────────────────────────────────────────
-- SUPPORT REQUESTS
-- ────────────────────────────────────────
-- What a student writes to the Lumen character in the corner of their
-- portal. A row rather than an email: a request that depends on a mail
-- provider having a good afternoon is a request that can vanish, and a
-- button that silently drops what a child typed is worse than no button.
CREATE TABLE IF NOT EXISTS public.support_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: a student who leaves the space should
  -- not take an unanswered question with them.
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

CREATE POLICY "support_staff_all" ON public.support_requests
  FOR ALL USING (public.is_staff_of(teacher_id)) WITH CHECK (public.is_staff_of(teacher_id));

-- Both halves matter: without the student_id check one student could
-- file a request as another, and without is_member_of they could file
-- into another teacher's inbox.
CREATE POLICY "support_student_write" ON public.support_requests
  FOR INSERT WITH CHECK (public.is_member_of(teacher_id) AND student_id = auth.uid());

CREATE POLICY "support_student_read" ON public.support_requests
  FOR SELECT USING (student_id = auth.uid());

-- Deliberately no student UPDATE or DELETE policy: closing a request is
-- the teacher's word on it, and a student cannot withdraw a report of a
-- problem that may still be real for everyone else.

-- ────────────────────────────────────────
-- ACTIVITY LOG (per tenant)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID REFERENCES public.teachers(id) ON DELETE CASCADE,
  actor_id    UUID,
  actor_name  TEXT,
  event_type  TEXT NOT NULL,
  detail      TEXT,
  page        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_staff_read" ON public.activity_log
  FOR SELECT USING (public.is_staff_of(teacher_id));

-- Anyone in the tenant may add to it (the content guard logs copy attempts
-- from the student portal); nobody may edit or delete what is written.
CREATE POLICY "activity_member_insert" ON public.activity_log
  FOR INSERT WITH CHECK (public.is_member_of(teacher_id));

CREATE POLICY "activity_owner_all" ON public.activity_log
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- ────────────────────────────────────────
-- LEADS (the "request a setup" form on the marketing site)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  subject       TEXT,
  student_count INTEGER,
  plan_code     TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'won', 'lost')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- The form is on a public page, so the anon role has to be able to write —
-- but only to write. Nothing anonymous can read back what others submitted.
CREATE POLICY "leads_public_insert" ON public.leads
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "leads_owner_all" ON public.leads
  FOR ALL USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- ────────────────────────────────────────
-- HOW MANY STUDENTS A TEACHER MAY STILL ADD
-- ────────────────────────────────────────
-- SECURITY DEFINER so a teacher gets the count without being able to read
-- the subscription rows of anyone else.
CREATE OR REPLACE FUNCTION public.my_student_allowance()
RETURNS TABLE (used INTEGER, allowed INTEGER, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t UUID := public.jwt_teacher_id();
BEGIN
  IF t IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT (SELECT COUNT(*)::INTEGER FROM public.profiles p
              WHERE p.teacher_id = t AND p.role = 'student' AND p.is_active),
           COALESCE(s.student_limit, 0),
           COALESCE(s.status, 'none')
      FROM public.subscriptions s WHERE s.teacher_id = t;
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_student_allowance() TO authenticated;

-- ────────────────────────────────────────
-- PERFORMANCE INDEXES
-- ────────────────────────────────────────
-- Every query in the portals is filtered by tenant first, so that is the
-- leading column on each of these.
CREATE INDEX IF NOT EXISTS idx_profiles_tenant       ON public.profiles(teacher_id, role);
CREATE INDEX IF NOT EXISTS idx_courses_tenant        ON public.courses(teacher_id, is_active);
CREATE INDEX IF NOT EXISTS idx_courses_order         ON public.courses(teacher_id, order_index);
CREATE INDEX IF NOT EXISTS idx_tests_order           ON public.practice_tests(course_id, order_index);
-- One deadline per test per group, and one for the whole course. Two
-- partial indexes because a NULL group_id does not collide with itself.
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_assignment_group  ON public.test_assignments(test_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_assignment_course ON public.test_assignments(test_id) WHERE group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_test_assignments_course       ON public.test_assignments(course_id, due_at);
CREATE INDEX IF NOT EXISTS idx_modules_course_order  ON public.modules(course_id, order_index);
CREATE INDEX IF NOT EXISTS idx_lessons_module_order  ON public.lessons(module_id, order_index);
CREATE INDEX IF NOT EXISTS idx_materials_lesson      ON public.lesson_materials(lesson_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student   ON public.enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_group     ON public.enrollments(group_id);
CREATE INDEX IF NOT EXISTS idx_groups_course         ON public.groups(teacher_id, course_id);
-- Two groups called "Sunday" on one course make the picker useless. On
-- lower() so "sunday" typed in a hurry is caught as the one that exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_unique_name ON public.groups (course_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_enrollments_course    ON public.enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_completions_student   ON public.lesson_completions(student_id);
CREATE INDEX IF NOT EXISTS idx_bank_tenant           ON public.question_bank(teacher_id, course_id);
CREATE INDEX IF NOT EXISTS idx_bank_unit             ON public.question_bank(teacher_id, module_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_bank_section          ON public.question_bank(teacher_id, section_id);
-- The one question api/practice.js asks of the bank.
CREATE INDEX IF NOT EXISTS idx_bank_practice         ON public.question_bank(teacher_id, module_id)
  WHERE is_published = true AND practice_ok = true;
-- What the teacher's dashboard asks for: the requests still waiting.
CREATE INDEX IF NOT EXISTS idx_support_open          ON public.support_requests(teacher_id, created_at DESC)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_sections_tenant       ON public.test_sections(teacher_id, order_index);
-- The lookup that keeps saving a test from filing the same question twice.
CREATE INDEX IF NOT EXISTS idx_bank_text_key         ON public.question_bank(teacher_id, text_key);
CREATE INDEX IF NOT EXISTS idx_tests_tenant          ON public.practice_tests(teacher_id, course_id);
CREATE INDEX IF NOT EXISTS idx_test_questions_test   ON public.test_questions(test_id, order_index);
CREATE INDEX IF NOT EXISTS idx_attempts_student      ON public.test_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_tenant_time  ON public.test_attempts(teacher_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignments_tenant    ON public.assignments(teacher_id, course_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student   ON public.assignment_submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_submissions_pending   ON public.assignment_submissions(teacher_id) WHERE score IS NULL;
CREATE INDEX IF NOT EXISTS idx_announcements_tenant  ON public.announcements(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_tenant_time  ON public.activity_log(teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant       ON public.invoices(teacher_id, issued_at DESC);

-- ────────────────────────────────────────
-- AUTO-UPDATE updated_at
-- ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS teachers_updated_at ON public.teachers;
CREATE TRIGGER teachers_updated_at BEFORE UPDATE ON public.teachers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ────────────────────────────────────────
-- STORAGE BUCKETS
-- ────────────────────────────────────────
-- Files are namespaced by tenant: every object key starts with the
-- teacher's id, and the policies below are what make that a boundary
-- rather than a naming convention.
INSERT INTO storage.buckets (id, name, public)
VALUES ('lesson-media', 'lesson-media', false),
       ('submissions',  'submissions',  false),
       ('branding',     'branding',     true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "tenant_media_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'lesson-media'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT);

CREATE POLICY "tenant_media_write" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'lesson-media'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT
         AND public.jwt_role() IN ('teacher', 'assistant'))
  WITH CHECK (bucket_id = 'lesson-media'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT
         AND public.jwt_role() IN ('teacher', 'assistant'));

CREATE POLICY "tenant_submissions_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'submissions'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT);

CREATE POLICY "tenant_submissions_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'submissions'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT
         AND (public.jwt_role() IN ('teacher', 'assistant') OR owner = auth.uid()));
