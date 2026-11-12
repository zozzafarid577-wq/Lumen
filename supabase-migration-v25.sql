-- ================================================================
-- Lumen migration v25 — one teacher, several subjects; prices kept private
--
-- Safe to run twice. It writes no rows.
--
--   teachers.group_id   the main space a subject belongs to. A teacher
--                       with Biology, Chemistry and Physics has one main
--                       space and two subjects under it: each its own
--                       space (students, courses, brand), all on the main
--                       space's plan, sharing its student places, and one
--                       sign-in that switches between them
--                       (api/_lib/spaces.js). NULL = a main space.
--
--   Prices are Lumen's business, not the teacher's screen. Teachers and
--   assistants no longer read their subscription row, their invoices or
--   the price list; the Subscription page asks the server for the plan
--   name, status and places only (api/support.js, flow "my-plan"). The
--   Lumen console still reads all three through its owner policies.
-- ================================================================

ALTER TABLE public.teachers ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES public.teachers(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_teachers_group ON public.teachers (group_id) WHERE group_id IS NOT NULL;

DROP POLICY IF EXISTS "subs_staff_read" ON public.subscriptions;
DROP POLICY IF EXISTS "invoices_staff_read" ON public.invoices;
DROP POLICY IF EXISTS "plans_public_read" ON public.plans;

-- The places count is the group's: every subject shares the main space's plan.
CREATE OR REPLACE FUNCTION public.my_student_allowance()
RETURNS TABLE (used INTEGER, allowed INTEGER, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t UUID := public.jwt_teacher_id();
  m UUID;
BEGIN
  IF t IS NULL THEN RETURN; END IF;
  SELECT COALESCE(x.group_id, x.id) INTO m FROM public.teachers x WHERE x.id = t;
  IF m IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT (SELECT COUNT(*)::INTEGER FROM public.profiles p
              JOIN public.teachers sp ON sp.id = p.teacher_id
             WHERE (sp.id = m OR sp.group_id = m) AND p.role = 'student' AND p.is_active),
           COALESCE(s.student_limit, 0),
           COALESCE(s.status, 'none')
      FROM public.subscriptions s WHERE s.teacher_id = m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_student_allowance() TO authenticated;
