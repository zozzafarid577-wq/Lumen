-- ================================================================
-- Lumen migration v17 — messages and notifications
--
-- Safe to run twice. It writes no rows except a one-off date on lessons
-- that existed before this migration (see LESSONS below).
--
-- WHAT CHANGES
--
-- 1. MESSAGES. A student and their teacher can write to each other.
--    One conversation per student: the student writes to "my teacher",
--    and the teacher and any assistant answer from one inbox. A row is
--    one message; `from_staff` says which side wrote it.
--
--    Nobody edits or deletes a message — there are no UPDATE or DELETE
--    policies. The one change allowed is marking messages read, and
--    that goes through mark_messages_read(), which can only touch the
--    caller's own conversation and only the `read_at` column.
--
-- 2. NOTIFICATIONS. The bell in the top bar is built from what is
--    already there — new tests, newly opened lessons, announcements,
--    deadlines, unread messages — so it needs no table of its own. It
--    needs two dates it could not work out before:
--      · profiles.notif_seen_at — when this person last opened the bell,
--        so the badge counts only what arrived since.
--      · lessons.created_at and modules.released_at — when a lesson
--        became something a student can see.
--
-- 4. MARKS FROM PAPERS DONE IN CLASS. practice_tests.is_offline marks a
--    test done on paper; its marks are typed in as test_attempts rows.
--
-- 3. PHONE POP-UPS. push_subscriptions holds the browser push endpoint
--    of each device that said yes to notifications. app_secrets holds
--    the server's push signing key. Nobody but the API's service-role
--    key reads app_secrets (RLS on, no policies).
-- ================================================================

-- ────────────────────────────────────────
-- MESSAGES
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  -- The conversation. Every message, from either side, names the student
  -- it belongs to.
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  from_staff BOOLEAN NOT NULL,
  body       TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_thread_idx  ON public.messages (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_teacher_idx ON public.messages (teacher_id, created_at DESC);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_staff_read"   ON public.messages;
DROP POLICY IF EXISTS "messages_staff_send"   ON public.messages;
DROP POLICY IF EXISTS "messages_student_read" ON public.messages;
DROP POLICY IF EXISTS "messages_student_send" ON public.messages;

CREATE POLICY "messages_staff_read" ON public.messages
  FOR SELECT USING (public.is_staff_of(teacher_id));

-- Staff write as themselves, as staff, to a student of their own space.
CREATE POLICY "messages_staff_send" ON public.messages
  FOR INSERT WITH CHECK (
    public.is_staff_of(teacher_id)
    AND from_staff = true
    AND sender_id = auth.uid()
    AND read_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = messages.student_id AND p.teacher_id = messages.teacher_id AND p.role = 'student'
    )
  );

CREATE POLICY "messages_student_read" ON public.messages
  FOR SELECT USING (student_id = auth.uid() AND public.is_member_of(teacher_id));

-- A student writes only into their own conversation, only as themselves.
CREATE POLICY "messages_student_send" ON public.messages
  FOR INSERT WITH CHECK (
    student_id = auth.uid()
    AND sender_id = auth.uid()
    AND from_staff = false
    AND read_at IS NULL
    AND public.jwt_role() = 'student'
    AND public.is_member_of(teacher_id)
  );

-- Marking read. A student marks what staff wrote to them; staff mark
-- what one student wrote. Nothing else about a message can change.
CREATE OR REPLACE FUNCTION public.mark_messages_read(p_student UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.jwt_role() = 'student' THEN
    UPDATE public.messages SET read_at = NOW()
     WHERE student_id = auth.uid() AND from_staff AND read_at IS NULL;
  ELSIF public.jwt_role() IN ('teacher', 'assistant') THEN
    UPDATE public.messages SET read_at = NOW()
     WHERE student_id = p_student AND teacher_id = public.jwt_teacher_id()
       AND NOT from_staff AND read_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_messages_read(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_messages_read(UUID) TO authenticated;

-- New messages arrive on the open page without a reload. Realtime
-- applies the read policies above, so nobody hears another conversation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END $$;

-- ────────────────────────────────────────
-- NOTIFICATION DATES
-- ────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS notif_seen_at TIMESTAMPTZ;

-- LESSONS. Lessons that already exist are dated far in the past so the
-- first time a student opens the bell it is not forty "new lessons".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'created_at') THEN
    ALTER TABLE public.lessons ADD COLUMN created_at TIMESTAMPTZ;
    UPDATE public.lessons SET created_at = '2020-01-01' WHERE created_at IS NULL;
    ALTER TABLE public.lessons ALTER COLUMN created_at SET DEFAULT NOW();
    ALTER TABLE public.lessons ALTER COLUMN created_at SET NOT NULL;
  END IF;
END $$;

-- When a unit was opened to students. Set the moment `is_done` turns on;
-- a unit that is already open keeps NULL and counts as old news.
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.stamp_module_release()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_done AND (TG_OP = 'INSERT' OR NOT COALESCE(OLD.is_done, false)) THEN
    NEW.released_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS modules_stamp_release ON public.modules;
CREATE TRIGGER modules_stamp_release
  BEFORE INSERT OR UPDATE OF is_done ON public.modules
  FOR EACH ROW EXECUTE FUNCTION public.stamp_module_release();

-- ────────────────────────────────────────
-- PHONE POP-UPS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id UUID REFERENCES public.teachers(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_own" ON public.push_subscriptions;
CREATE POLICY "push_own" ON public.push_subscriptions
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- The server's push signing key, made by the API the first time it is
-- needed. Readable by the service-role key only.
CREATE TABLE IF NOT EXISTS public.app_secrets (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;

-- One row per reminder sent, so the daily deadline reminder never sends
-- the same one twice.
CREATE TABLE IF NOT EXISTS public.notify_log (
  key        TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notify_log ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────
-- MARKS FROM PAPERS DONE IN CLASS
-- ────────────────────────────────────────
-- A test taken on paper, outside Lumen. It is a practice_tests row with
-- no questions, and each student's mark is an ordinary test_attempts row
-- typed in by the teacher or an assistant — so the mark shows wherever
-- the others do: Progress, My scores, the parents' email and the morning
-- group report. Students are never offered it as something to sit.
ALTER TABLE public.practice_tests ADD COLUMN IF NOT EXISTS is_offline BOOLEAN NOT NULL DEFAULT false;
-- The group it was done with, so the marks sheet reopens on the right
-- students.
ALTER TABLE public.practice_tests ADD COLUMN IF NOT EXISTS offline_group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL;
