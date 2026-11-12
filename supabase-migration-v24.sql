-- ================================================================
-- Lumen migration v24 — reports that go to parents on their own
--
-- Safe to run twice. It writes no rows.
--
--   teachers.parent_reports  what the morning run sends parents for this
--                            space (api/_lib/parent-reports.js):
--                            { "daily": true, "weekly": true, "weekly_day": 6 }
--                            daily  = the morning after a day with a test,
--                                     a lesson or homework due in it;
--                            weekly = once a week, on weekly_day (0 Sunday …
--                                     6 Saturday), with every unit sorted into
--                                     strong / getting there / needs work.
--                            Empty, the default, sends nothing.
-- ================================================================

ALTER TABLE public.teachers ADD COLUMN IF NOT EXISTS parent_reports JSONB NOT NULL DEFAULT '{}'::jsonb;
