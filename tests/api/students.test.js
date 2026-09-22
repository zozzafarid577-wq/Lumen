import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, ASSISTANT_USER, STUDENT_USER, OWNER_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser, withSubscription } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/students.js';

const COURSE = 'course-1';

function courseLookup(ids = [COURSE]) {
  return { 'courses.select': { data: ids.map(id => ({ id })), error: null } };
}

async function call(body, req = {}) {
  const res = makeRes();
  await handler(makeReq({ body, ...req }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(TEACHER_USER);
});

describe('creating a student', () => {
  beforeEach(() => {
    configureSupabaseMock({ results: { ...withSubscription(), ...courseLookup() } });
  });

  it('creates the account inside the caller’s own tenant', async () => {
    const res = await call({ full_name: 'Sara Ahmed', email: 'Sara@Example.com', course_ids: [COURSE] });

    expect(res.statusCode).toBe(200);
    expect(res.body.password).toHaveLength(12);
    expect(res.body.email).toBe('sara@example.com');

    const [created] = getSupabaseCalls('auth.admin.createUser');
    // These two claims are what row-level security reads. If they are ever
    // wrong or missing, the new student can see another teacher's space.
    expect(created.payload.app_metadata).toEqual({ role: 'student', teacher_id: TEACHER_ID });

    const [profile] = getSupabaseCalls('profiles.insert');
    expect(profile.payload).toMatchObject({ teacher_id: TEACHER_ID, role: 'student', must_change_pw: true });

    const [enrol] = getSupabaseCalls('enrollments.insert');
    expect(enrol.payload).toEqual([{ teacher_id: TEACHER_ID, student_id: 'new-uid', course_id: COURSE }]);
  });

  it('ignores a teacher_id in the request body', async () => {
    const res = await call({
      full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE],
      teacher_id: OTHER_TEACHER_ID,
    });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('refuses a course that belongs to someone else', async () => {
    configureSupabaseMock({ results: courseLookup([]) });   // the tenant filter finds nothing
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: ['someone-elses-course'] });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('needs at least one course', async () => {
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an email that is not one', async () => {
    const res = await call({ full_name: 'Sara', email: 'not-an-email', course_ids: [COURSE] });
    expect(res.statusCode).toBe(400);
  });

  it('says so when the address is already taken', async () => {
    configureSupabaseMock({
      results: { 'auth.admin.listUsers': { data: { users: [{ email: 'sara@example.com' }] }, error: null } },
    });
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('deletes the auth user again when the profile insert fails', async () => {
    configureSupabaseMock({ results: { 'profiles.insert': { data: null, error: { message: 'boom' } } } });
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });

    expect(res.statusCode).toBe(500);
    // A student who can sign in but has no profile cannot be helped by
    // anyone, so the half-made account must not survive.
    expect(getSupabaseCalls('auth.admin.deleteUser')[0].payload.id).toBe('new-uid');
  });

  it('deletes the auth user again when the enrolment fails', async () => {
    configureSupabaseMock({ results: { 'enrollments.insert': { data: null, error: { message: 'boom' } } } });
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });

    expect(res.statusCode).toBe(500);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(1);
  });
});

describe('the plan limit', () => {
  beforeEach(() => { configureSupabaseMock({ results: courseLookup() }); });

  it('refuses once every place is used', async () => {
    asUser(TEACHER_USER, { studentCount: 60 });
    configureSupabaseMock({ results: withSubscription({ student_limit: 60 }) });

    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toMatch(/60 students/);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('allows the last place', async () => {
    asUser(TEACHER_USER, { studentCount: 59 });
    configureSupabaseMock({ results: withSubscription({ student_limit: 60 }) });

    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(200);
  });

  it('pauses new accounts while a subscription is past due', async () => {
    configureSupabaseMock({ results: withSubscription({ status: 'past_due' }) });
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toMatch(/past due/i);
  });

  it('refuses when there is no subscription at all', async () => {
    configureSupabaseMock({ results: { 'subscriptions.select': { data: null, error: null } } });
    const res = await call({ full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(402);
  });
});

describe('acting on an existing student', () => {
  const mine    = { id: 'stu-1', full_name: 'Sara', email: 'sara@example.com', role: 'student', teacher_id: TEACHER_ID, is_active: true };
  const theirs  = { ...mine, id: 'stu-2', teacher_id: OTHER_TEACHER_ID };

  beforeEach(() => {
    asUser(TEACHER_USER, { extraProfiles: { 'stu-1': mine, 'stu-2': theirs } });
    configureSupabaseMock({ results: withSubscription() });
  });

  it('resets a password and requires it to be changed again', async () => {
    const res = await call({ action: 'reset_password', student_id: 'stu-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.password).toHaveLength(12);

    const [update] = getSupabaseCalls('profiles.update');
    expect(update.payload).toEqual({ must_change_pw: true });
  });

  it('will not touch a student in another tenant', async () => {
    for (const action of ['reset_password', 'set_active', 'delete']) {
      resetSupabaseMock();
      asUser(TEACHER_USER, { extraProfiles: { 'stu-2': theirs } });
      const res = await call({ action, student_id: 'stu-2' });
      expect(res.statusCode, action).toBe(403);
      expect(getSupabaseCalls('auth.admin.deleteUser'), action).toHaveLength(0);
    }
  });

  it('checks the plan again before switching a paused student back on', async () => {
    asUser(TEACHER_USER, { extraProfiles: { 'stu-1': { ...mine, is_active: false } }, studentCount: 60 });
    configureSupabaseMock({ results: withSubscription({ student_limit: 60 }) });

    const res = await call({ action: 'set_active', student_id: 'stu-1', is_active: true });
    expect(res.statusCode).toBe(402);
  });

  it('pauses without checking the plan', async () => {
    asUser(TEACHER_USER, { extraProfiles: { 'stu-1': mine }, studentCount: 60 });
    configureSupabaseMock({ results: withSubscription({ student_limit: 60 }) });

    const res = await call({ action: 'set_active', student_id: 'stu-1', is_active: false });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an account that is not a student', async () => {
    asUser(TEACHER_USER, {
      extraProfiles: { 'asst-1': { id: 'asst-1', role: 'assistant', teacher_id: TEACHER_ID, full_name: 'X' } },
    });
    const res = await call({ action: 'delete', student_id: 'asst-1' });
    expect(res.statusCode).toBe(400);
  });
});

describe('who may call it', () => {
  it('turns away a request with no token', async () => {
    const res = await call({}, { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('turns away a student', async () => {
    asUser(STUDENT_USER);
    const res = await call({ full_name: 'X', email: 'x@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(403);
  });

  it('turns away an assistant without the students permission', async () => {
    asUser(ASSISTANT_USER, { profile: { staff_perms: ['courses'] } });
    const res = await call({ full_name: 'X', email: 'x@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(403);
  });

  it('lets an assistant with the students permission through', async () => {
    asUser(ASSISTANT_USER, { profile: { staff_perms: ['students'] } });
    configureSupabaseMock({ results: { ...withSubscription(), ...courseLookup() } });
    const res = await call({ full_name: 'Nour Hassan', email: 'nour@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(200);
  });

  it('turns away a deactivated caller', async () => {
    asUser(TEACHER_USER, { profile: { is_active: false } });
    const res = await call({ full_name: 'X', email: 'x@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(403);
  });

  it('makes Lumen staff name the tenant explicitly', async () => {
    asUser(OWNER_USER);
    const res = await call({ full_name: 'X', email: 'x@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/teacher_id/);
  });

  it('rejects anything but POST', async () => {
    const res = await call({}, { method: 'GET' });
    expect(res.statusCode).toBe(405);
  });
});
