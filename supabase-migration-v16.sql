-- ================================================================
-- Lumen migration v16 — students choose their own password
--
-- Safe to run twice. It writes no rows.
--
-- WHAT CHANGES
--
-- A student used to be handed a password somebody else had generated,
-- read out or typed into WhatsApp, and asked to change it later. Most
-- never did, so the password several people had seen stayed the one
-- that opened the account.
--
-- Now a new student gets a link instead. It opens one page, which asks
-- them to choose a password, and nothing but their own choice is ever
-- their password. A teacher who needs to let a student back in issues
-- another link; there is no password for anyone to read.
--
-- This table is what those links are made of. One row per link:
-- single-use, dated, and thrown away once it has been used or
-- replaced.
--
-- WHO CAN READ IT
--
-- Nobody. Row-level security is on and there are no policies, so the
-- anon and authenticated roles see an empty table. Only the API's
-- service-role key touches it, which is what makes the token a
-- credential rather than a lookup key — a signed-in student cannot
-- list the tokens belonging to anybody else, because they cannot list
-- tokens at all.
-- ================================================================

CREATE TABLE IF NOT EXISTS public.password_invites (
  -- The token IS the row. It goes in the URL and nothing else
  -- identifies the link, so it is the primary key.
  token      TEXT PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Carried so that a teacher's links go when their space does, and so
  -- the activity log can be written without a second lookup.
  teacher_id UUID NOT NULL REFERENCES public.teachers(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set the moment it is spent. A used link is kept rather than deleted
  -- so that a student who clicks the same WhatsApp message twice is told
  -- "already used" instead of "never existed".
  used_at    TIMESTAMPTZ
);

-- The lookup the public page makes, and the one issuing a new link
-- makes to clear the old ones.
CREATE INDEX IF NOT EXISTS password_invites_student_idx
  ON public.password_invites (student_id, created_at DESC);

ALTER TABLE public.password_invites ENABLE ROW LEVEL SECURITY;

-- Deliberately no policies. See the header.

-- ────────────────────────────────────────
-- Tidying
-- ────────────────────────────────────────
-- Spent and expired links are of no use to anybody after a while. This
-- is safe to run whenever, by hand or on a schedule; nothing depends on
-- an old row existing.
--
--   DELETE FROM public.password_invites
--   WHERE (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '30 days')
--      OR expires_at < NOW() - INTERVAL '30 days';
