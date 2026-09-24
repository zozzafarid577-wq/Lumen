import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

const sent = [];
let sendResult = { sent: true };
vi.mock('../../api/_lib/email.js', () => ({
  sendEmail: async (args) => { sent.push(args); return sendResult; },
  emailStatus: () => ({ ready: true }),
}));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  STUDENT_USER, TEACHER_USER, TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/result-email.js';

const TEST = 'test-1';

const ATTEMPT = {
  id: 'attempt-1', test_id: TEST, percentage: '82.00', score: 41, max_score: 50,
  passed: true, completed_at: '2026-09-24T10:00:00Z',
};

// The student, their test and their teacher, as the handler reads them.
function world({ attempt = ATTEMPT, parentEmail = 'parent@example.com' } = {}) {
  configureSupabaseMock({ results: {
    'test_attempts.select': { data: attempt, error: null },
    'practice_tests.select': { data: { title: 'Unit 1 quiz', passing_score_pct: 60 }, error: null },
    'teachers.select': { data: { display_name: 'Ms Farid' }, error: null },
    // authenticate() reads the whole profile; the handler asks only for
    // the two columns it needs. Same table, same id — told apart by what
    // each one selected.
    'profiles.select': (call) => String(call.columns).includes('parent_email')
      ? { data: { full_name: 'Sara Farid', parent_email: parentEmail }, error: null }
      : { data: { id: STUDENT_USER.id, teacher_id: TEACHER_ID, role: 'student', full_name: 'Sara Farid', is_active: true }, error: null },
  } });
}

async function call(body = { test_id: TEST }) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(STUDENT_USER);
  sent.length = 0;
  sendResult = { sent: true };
});

describe('emailing a result to a parent', () => {
  it('sends the mark to the parent on file', async () => {
    world();
    const res = await call();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(sent[0].to).toBe('parent@example.com');
    expect(sent[0].subject).toBe('Sara Farid — Unit 1 quiz — 82%');
    expect(sent[0].html).toMatch(/82%/);
    expect(sent[0].html).toMatch(/41 out of 50/);
  });

  it('reads the mark from the database, not from the request', async () => {
    // A student naming a percentage of their own choosing must not be
    // able to email their parent a score they did not get.
    world();
    await call({ test_id: TEST, percentage: 100, score: 50, passed: true });

    expect(sent[0].subject).toMatch(/82%/);
    // The big figure in the email is the one the database holds.
    expect(sent[0].html).toMatch(/>82%<\/div>/);
    expect(sent[0].html).not.toMatch(/>100%<\/div>/);
  });

  it('only ever looks at the caller’s own attempts', async () => {
    world();
    await call();

    const [lookup] = getSupabaseCalls('test_attempts.select');
    expect(lookup.filters.student_id).toBe(STUDENT_USER.id);
    expect(lookup.filters.test_id).toBe(TEST);
  });

  it('marks the attempt so it is never sent twice', async () => {
    world();
    await call();

    const [stamp] = getSupabaseCalls('test_attempts.update');
    expect(stamp.filters.id).toBe('attempt-1');
    expect(stamp.payload.parent_emailed_at).toBeTruthy();
  });

  it('says nothing and sends nothing when it has already gone', async () => {
    // The query excludes attempts already stamped, so an empty result is
    // a refreshed results page asking again.
    world({ attempt: null });
    const res = await call();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: false, why: 'already-sent-or-none' });
    expect(sent).toHaveLength(0);
  });

  it('does nothing when no parent email is on file', async () => {
    world({ parentEmail: '' });
    const res = await call();

    expect(res.body).toEqual({ sent: false, why: 'no-parent-email' });
    expect(sent).toHaveLength(0);
  });

  it('leaves the attempt unstamped when the send fails', async () => {
    // Otherwise a provider having a bad afternoon costs the parent the
    // result for good.
    world();
    sendResult = { sent: false, error: 'Brevo returned 500' };
    const res = await call();

    expect(res.body).toEqual({ sent: false });
    expect(getSupabaseCalls('test_attempts.update')).toHaveLength(0);
  });

  it('degrades quietly when migration v9 has not been run', async () => {
    world();
    configureSupabaseMock({ results: {
      'test_attempts.select': { data: null, error: { message: 'column "parent_emailed_at" does not exist' } },
    } });

    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: false, why: 'unavailable' });
    expect(sent).toHaveLength(0);
  });

  it('is for students; staff cannot ask it to send', async () => {
    // world() last would put a student profile back on the id, so the
    // caller is made a teacher after the rest of the world is set up.
    world();
    asUser(TEACHER_USER);
    const res = await call();

    expect(res.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('needs a test to have been named', async () => {
    world();
    const res = await call({});
    expect(res.statusCode).toBe(400);
  });
});
