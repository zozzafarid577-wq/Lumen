-- ================================================================
-- Lumen migration v19 — each teacher's own look
--
-- Safe to run twice. It writes no rows.
--
-- teachers.branding holds how a teacher's space looks to their students
-- and staff: a colour theme (or their own colour), their name or logo in
-- place of Lumen's, and the words on the students' welcome banner. One
-- JSON column rather than five, so the next idea needs no migration:
--   { "theme": "ocean", "primary": "#1F6FB2", "own_name": true,
--     "welcome_title": "Hi {name}, welcome to {course}!",
--     "welcome_text": "Do one lesson a day." }
--
-- The logo is uploaded to the public "branding" bucket, into a folder
-- named after the teacher — only that teacher may write there.
-- ================================================================

ALTER TABLE public.teachers ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}'::jsonb;

DROP POLICY IF EXISTS "tenant_branding_write" ON storage.objects;
CREATE POLICY "tenant_branding_write" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'branding'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT
         AND public.jwt_role() = 'teacher')
  WITH CHECK (bucket_id = 'branding'
         AND (storage.foldername(name))[1] = public.jwt_teacher_id()::TEXT
         AND public.jwt_role() = 'teacher');
