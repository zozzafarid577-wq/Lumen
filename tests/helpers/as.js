import { configureSupabaseMock, PROFILES } from './supabase-mock.js';

// Sign the next request in as one of the fixture users.
//
// `profiles` is read for two different things — looking a person up by id,
// and counting a teacher's students — so one resolver has to answer both.
// `extraProfiles` adds other people's rows (a student being acted on, an
// assistant being edited), keyed by id.
export function asUser(user, { profile, extraProfiles = {}, studentCount = 0 } = {}) {
  const rows = { ...PROFILES, ...extraProfiles };
  if (profile) rows[user.id] = { ...rows[user.id], ...profile };

  configureSupabaseMock({
    authUser: user,
    results: {
      'profiles.select': (call) => {
        if (call.opts?.count) return { data: null, error: null, count: studentCount };
        const row = rows[call.filters.id];
        return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
      },
    },
  });
  return rows;
}

// A subscription with room to spare, unless a test says otherwise.
export function withSubscription(overrides = {}) {
  return {
    'subscriptions.select': {
      data: { teacher_id: 'teacher-1', status: 'active', student_limit: 60, monthly_fee_egp: 8000, ...overrides },
      error: null,
    },
  };
}
