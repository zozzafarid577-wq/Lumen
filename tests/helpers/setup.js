// The env vars api/_lib/supabase.js reads when it is first imported.
// They are never used to reach a real project: every test replaces the
// module with tests/helpers/supabase-mock.js.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
