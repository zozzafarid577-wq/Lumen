-- ================================================================
-- Lumen migration v26 — let a teacher's one sign-in move between subjects
--
-- Safe to run twice. It writes no rows.
--
-- profiles_guard_identity refuses any change to profiles.teacher_id, the
-- service role included, so switching subject (api/_lib/spaces.js) and
-- deleting a subject that the sign-in is sitting in always failed.
-- This is the one deliberate way past the guard: it moves a TEACHER's own
-- profile to another space of the SAME group (teachers.group_id, v25) and
-- nothing else. Only the service role (api/) may call it.
-- ================================================================

CREATE OR REPLACE FUNCTION public.move_teacher_within_group(p_user UUID, p_target UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cur UUID;
BEGIN
  SELECT teacher_id INTO cur FROM public.profiles WHERE id = p_user AND role = 'teacher';
  IF cur IS NULL THEN RAISE EXCEPTION 'not a teacher account'; END IF;
  IF (SELECT COALESCE(group_id, id) FROM public.teachers WHERE id = cur)
     IS DISTINCT FROM (SELECT COALESCE(group_id, id) FROM public.teachers WHERE id = p_target) THEN
    RAISE EXCEPTION 'that space is not in this teacher''s group';
  END IF;
  PERFORM set_config('lumen.admin_write', 'on', true);
  UPDATE public.profiles SET teacher_id = p_target WHERE id = p_user;
END;
$$;

REVOKE ALL ON FUNCTION public.move_teacher_within_group(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_teacher_within_group(UUID, UUID) TO service_role;
