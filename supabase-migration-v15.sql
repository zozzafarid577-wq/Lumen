-- ================================================================
-- Lumen migration v15 — put the group foreign keys back, and say so
--
-- Safe to run twice. It writes no rows. Run it even if you already ran
-- v14: this is the file to reach for whenever the group delete starts
-- failing again.
--
-- WHY THIS EXISTS, WHEN v14 ALREADY FIXED IT
--
-- v14 replaced two constraints so that deleting a group nulls only
-- `group_id`, leaving the NOT NULL `course_id` alone. That worked. Then
-- the same error came back.
--
-- The cause was the repo, not the database. `supabase-migration-v5.sql`
-- is where `enrollments_group_fk` was born, and it creates it with
-- DROP CONSTRAINT … ADD CONSTRAINT — carrying, until now, the bare
-- ON DELETE SET NULL. The README promises every migration is safe to
-- run twice and asks for them in order, so replaying v5 at any point
-- after v14 silently undid v14 and put the bug straight back. v11 had
-- the same shape for `invite_links`.
--
-- v5 and v11 now carry the column list themselves, so the order these
-- are replayed in no longer matters, and a test reads every SQL file in
-- the repo to keep it that way. This file is the repair for a database
-- that was caught by it in the meantime.
--
-- The symptom it fixes, for anyone searching:
--
--   null value in column "course_id" of relation "enrollments"
--   violates not-null constraint
--
-- raised when deleting a group with students in it — and, for the same
-- reason, when deleting a course whose groups have students in them.
-- ================================================================

-- ────────────────────────────────────────
-- 0. THE ONE THING THAT COULD STOP THIS
-- ────────────────────────────────────────
-- SET NULL with a column list is Postgres 15 and up, as in v14.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'Lumen v15 needs Postgres 15 or newer (this project is on %). '
      'Upgrade the project in Supabase → Project Settings → Infrastructure, then run this file again.',
      current_setting('server_version');
  END IF;
END $$;

-- ────────────────────────────────────────
-- 1. THE TWO CONSTRAINTS, AS THEY SHOULD BE
-- ────────────────────────────────────────
-- Identical to v14. Re-asserted rather than checked first, because the
-- whole point is to land on the right definition from whatever the
-- database currently holds.
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_group_fk;
ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id)
  ON DELETE SET NULL (group_id);

ALTER TABLE public.invite_links DROP CONSTRAINT IF EXISTS invite_links_group_fk;
ALTER TABLE public.invite_links ADD CONSTRAINT invite_links_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id)
  ON DELETE SET NULL (group_id);

-- ────────────────────────────────────────
-- 2. WHAT IT SHOULD LOOK LIKE AFTERWARDS
-- ────────────────────────────────────────
-- Read-only. Both rows should end in `ON DELETE SET NULL (group_id)`.
-- Anything still reading plain `ON DELETE SET NULL` did not take.
SELECT conrelid::regclass AS table_name,
       conname            AS constraint_name,
       pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname IN ('enrollments_group_fk', 'invite_links_group_fk')
 ORDER BY 1;
