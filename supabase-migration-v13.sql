-- ================================================================
-- Lumen migration v13 — remove the duplicate questions, and make the
-- database refuse new ones
--
-- ⚠ THIS ONE DELETES ROWS. Run migration v12 first, run the read-only
-- query at the bottom of it, and look at what comes back. This file
-- removes exactly the rows that query listed under anything other than
-- `row_v13_keeps`.
--
-- Safe to run twice: the second run finds no duplicates and the index
-- is already there.
--
-- What it does, and what it cannot touch:
--
--   Of each group of identical questions it keeps the OLDEST — the one
--   whose created_at is earliest, ties broken by id so the choice is
--   never ambiguous — and deletes the rest. The oldest is kept because
--   it is the one a teacher has had longest, and the one any labelling
--   they did by hand is most likely to be on.
--
--   Deleting a bank row cannot affect a test, an attempt or a result.
--   `test_questions` holds its own copy of the question text and its
--   options, and has no foreign key to this table — nothing in the
--   database references question_bank at all. A paper already set stays
--   exactly as it was, and so does every mark on it.
--
--   Then a UNIQUE index, which is the part that actually fixes this.
--   Until now the only thing stopping duplicates was api/save-test.js
--   reading the bank and deciding what was new — a check that two saves
--   in the same second both pass before either has written. An index is
--   the only thing that settles that, and it also covers the bank page,
--   which writes to this table straight from the browser.
-- ================================================================

-- ────────────────────────────────────────
-- 1. COLLAPSE EACH GROUP TO ITS OLDEST ROW
-- ────────────────────────────────────────
-- Scoped by teacher_id as well as text_key: two teachers asking the same
-- question are two questions. Nothing here crosses a tenant.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY teacher_id, text_key
           ORDER BY created_at, id
         ) AS n
    FROM public.question_bank
)
DELETE FROM public.question_bank
 WHERE id IN (SELECT id FROM ranked WHERE n > 1);

-- ────────────────────────────────────────
-- 2. REFUSE THE NEXT ONE
-- ────────────────────────────────────────
-- The plain index this replaces (idx_bank_text_key, from v1) made the
-- lookup fast but permitted the duplicate it was looking for.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_text_key_unique
  ON public.question_bank (teacher_id, text_key);

DROP INDEX IF EXISTS public.idx_bank_text_key;
