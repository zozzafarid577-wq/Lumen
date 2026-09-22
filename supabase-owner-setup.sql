-- ================================================================
-- Lumen — make the first admin (Lumen staff) account
--
-- Row-level security has no back door, so the very first account has
-- to be made outside the app. Run this ONCE, after supabase-setup.sql.
--
-- BEFORE RUNNING:
--   1. Supabase → Authentication → Users → Add user
--      Enter the email below and a password. Tick "Auto Confirm User".
--   2. Change owner_email and owner_name on the two lines below.
--   3. Run this whole file in the SQL editor.
--
-- AFTER RUNNING: sign out and sign in again at /login.html. The `role`
-- claim is read out of the access token, and the token you are holding
-- was minted before this script ran.
-- ================================================================

DO $$
DECLARE
  -- ── Fill these in ────────────────────────────────────────────
  owner_email TEXT := 'CHANGE-ME@example.com';
  owner_name  TEXT := 'Lumen';
  -- ─────────────────────────────────────────────────────────────
  uid UUID;
BEGIN
  SELECT id INTO uid FROM auth.users WHERE lower(email) = lower(owner_email);

  IF uid IS NULL THEN
    RAISE EXCEPTION
      'No auth user with the email %. Create it first: Authentication → Users → Add user (tick "Auto Confirm User"), then run this again.',
      owner_email;
  END IF;

  -- Two halves, and both are needed. The policies read `role` out of
  -- the JWT, which comes from app_metadata; the portal reads the
  -- profiles row. Setting one without the other gets you a half-signed-in
  -- account that is hard to diagnose.
  UPDATE auth.users
     SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('role', 'owner')
   WHERE id = uid;

  -- guard_profile_identity() refuses a role change on an existing
  -- profile. This is the deliberate way past it, and the only place in
  -- the project that uses it.
  PERFORM set_config('lumen.admin_write', 'on', true);

  INSERT INTO public.profiles (id, teacher_id, role, full_name, email, must_change_pw)
  VALUES (uid, NULL, 'owner', owner_name, lower(owner_email), false)
  ON CONFLICT (id) DO UPDATE
    SET role           = 'owner',
        teacher_id     = NULL,
        full_name      = EXCLUDED.full_name,
        email          = EXCLUDED.email,
        must_change_pw = false;

  RAISE NOTICE 'Lumen admin ready: % (%). Sign out and back in at /login.html.', owner_email, uid;
END $$;

-- Check it landed. Both columns should say owner.
SELECT p.email,
       p.role                                   AS profile_role,
       u.raw_app_meta_data ->> 'role'           AS token_role,
       p.teacher_id
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
 WHERE p.role = 'owner';
