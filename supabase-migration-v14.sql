-- ================================================================
-- Lumen migration v14 — let a group be deleted again
--
-- Safe to run twice. It writes no rows; it replaces two foreign key
-- constraints with the same constraints under a narrower ON DELETE.
--
-- The bug, from the teacher's side: deleting a group that has anyone
-- enrolled in it fails with
--
--   null value in column "course_id" of relation "enrollments"
--   violates not-null constraint
--
-- even though the confirmation dialog on the courses page promises the
-- opposite — "its 3 students stay on the course — they just stop being
-- in a group".
--
-- Why. Both tables pair the group with its course in one composite
-- foreign key, so that an enrolment (or an invite link) can never name
-- a group that meets for a different course:
--
--   FOREIGN KEY (group_id, course_id) REFERENCES groups(id, course_id)
--     ON DELETE SET NULL
--
-- Plain ON DELETE SET NULL nulls EVERY column of the referencing key,
-- not just the one that pointed at the row being deleted. So deleting a
-- group asks Postgres to set group_id AND course_id to NULL, and
-- course_id is NOT NULL in both tables. The delete is refused, and the
-- error names course_id rather than the group, which is why it reads
-- like an enrolment bug rather than a constraint that nulls one column
-- too many.
--
-- Nothing is wrong with the data: no row ever got a null course_id,
-- because the constraint is what stopped the delete. This is only about
-- what happens on the next one.
--
-- The fix is the column list Postgres 15 added for exactly this:
-- ON DELETE SET NULL (group_id) nulls the group and leaves the course
-- alone. The pairing rule is unchanged — a group named here still has
-- to belong to the course named here.
-- ================================================================

-- ────────────────────────────────────────
-- 0. THE ONE THING THAT COULD STOP THIS
-- ────────────────────────────────────────
-- SET NULL with a column list is Postgres 15 and up. Supabase projects
-- created since late 2022 are on 15 or 17; a project older than that
-- needs an upgrade first (Project Settings → Infrastructure). Checked
-- here so the failure says which knob to turn, rather than pointing at
-- a bracket.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'Lumen v14 needs Postgres 15 or newer (this project is on %). '
      'Upgrade the project in Supabase → Project Settings → Infrastructure, then run this file again.',
      current_setting('server_version');
  END IF;
END $$;

-- ────────────────────────────────────────
-- 1. ENROLMENTS
-- ────────────────────────────────────────
-- Deleting a group a teacher no longer runs must not unenrol its
-- students. They lose a timetable, not their course — so group_id is
-- nulled and course_id is left where it is.
ALTER TABLE public.enrollments DROP CONSTRAINT IF EXISTS enrollments_group_fk;
ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id)
  ON DELETE SET NULL (group_id);

-- ────────────────────────────────────────
-- 2. INVITE LINKS
-- ────────────────────────────────────────
-- The same shape, and the same fix. This one had not been reported yet
-- only because it takes a group that a link points at: with the
-- enrolments constraint fixed on its own, the next delete would have
-- failed here instead, on invite_links.course_id.
--
-- A link outlives the group it was for. It still names the course, so
-- anyone holding the URL is enrolled onto the course without a class —
-- which is the same state as a link made before the timetable existed,
-- and the same state the students who were in that group are now in.
ALTER TABLE public.invite_links DROP CONSTRAINT IF EXISTS invite_links_group_fk;
ALTER TABLE public.invite_links ADD CONSTRAINT invite_links_group_fk
  FOREIGN KEY (group_id, course_id) REFERENCES public.groups(id, course_id)
  ON DELETE SET NULL (group_id);

-- ────────────────────────────────────────
-- 3. WHAT IT SHOULD LOOK LIKE AFTERWARDS
-- ────────────────────────────────────────
-- Read-only. Both rows should end in `ON DELETE SET NULL (group_id)`.
-- Anything still reading plain `ON DELETE SET NULL` did not take.
SELECT conrelid::regclass AS table_name,
       conname            AS constraint_name,
       pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname IN ('enrollments_group_fk', 'invite_links_group_fk')
 ORDER BY 1;
