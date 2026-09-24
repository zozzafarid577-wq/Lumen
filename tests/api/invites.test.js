import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, ASSISTANT_USER, STUDENT_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser, withSubscription } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/invites.js';

const COURSE = 'course-1';
const GROUP = 'grp-1';

const REG = {
  id: 'reg-1', teacher_id: TEACHER_ID, status: 'pending',
  full_name: 'Sara Ahmed', email: 'sara@example.com', phone: '01012345678',
  parent_phone: null, parent_email: null, course_id: COURSE, group_id: GROUP,
};

function ownCourse(row = { id: COURSE, title: 'SAT Math' }) {
  return { 'courses.select': { data: row, error: null } };
}

// The row the claim-before-create update hands back, then whatever the
// rollback does after it.
function claimSucceeds() {
  return { 'student_registrations.update': [{ data: { id: 'reg-1' }, error: null }, { data: null, error: null }] };
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

describe('making a link', () => {
  beforeEach(() => {
    configureSupabaseMock({ results: {
      ...ownCourse(),
      'invite_links.insert': { data: { id: 'inv-1', token: 'AbC123xyZ9' }, error: null },
    } });
  });

  it('returns a link built from the token it stored', async () => {
    const res = await call({ action: 'create', course_id: COURSE, label: 'Saturday 4pm' },
      { headers: { host: 'lumen.education' } });

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBe('AbC123xyZ9');
    expect(res.body.url).toBe('https://lumen.education/join/AbC123xyZ9');

    const [made] = getSupabaseCalls('invite_links.insert');
    expect(made.payload).toMatchObject({
      teacher_id: TEACHER_ID, course_id: COURSE, group_id: null,
      label: 'Saturday 4pm', max_uses: null,
    });
    expect(made.payload.token).toHaveLength(10);
  });

  it('opens the link ready to use', async () => {
    await call({ action: 'create', course_id: COURSE });
    const [made] = getSupabaseCalls('invite_links.insert');
    // is_open defaults to true in the schema; nothing here should be
    // switching it off.
    expect(made.payload.is_open).toBeUndefined();
  });

  it('ties it to the group that was chosen', async () => {
    configureSupabaseMock({ results: { 'groups.select': { data: { id: GROUP, course_id: COURSE }, error: null } } });

    const res = await call({ action: 'create', course_id: COURSE, group_id: GROUP });
    expect(res.statusCode).toBe(200);
    const [made] = getSupabaseCalls('invite_links.insert');
    expect(made.payload.group_id).toBe(GROUP);
  });

  it('refuses a group that belongs to a different course', async () => {
    configureSupabaseMock({ results: { 'groups.select': { data: { id: GROUP, course_id: 'course-9' }, error: null } } });

    const res = await call({ action: 'create', course_id: COURSE, group_id: GROUP });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/different course/i);
    expect(getSupabaseCalls('invite_links.insert')).toHaveLength(0);
  });

  it('refuses a group from another teacher’s space', async () => {
    configureSupabaseMock({ results: { 'groups.select': { data: null, error: null } } });
    const res = await call({ action: 'create', course_id: COURSE, group_id: 'grp-elsewhere' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not in your space/i);
  });

  it('refuses a course from another teacher’s space', async () => {
    configureSupabaseMock({ results: { 'courses.select': { data: null, error: null } } });
    const res = await call({ action: 'create', course_id: 'course-elsewhere' });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('invite_links.insert')).toHaveLength(0);
  });

  it('insists on a course', async () => {
    const res = await call({ action: 'create' });
    expect(res.statusCode).toBe(400);
  });

  it('ignores a teacher_id in the request body', async () => {
    const res = await call({ action: 'create', course_id: COURSE, teacher_id: OTHER_TEACHER_ID });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('invite_links.insert')).toHaveLength(0);
  });

  it('keeps a limit only when it is a sensible one', async () => {
    await call({ action: 'create', course_id: COURSE, max_uses: 30 });
    expect(getSupabaseCalls('invite_links.insert')[0].payload.max_uses).toBe(30);

    resetSupabaseMock();
    asUser(TEACHER_USER);
    configureSupabaseMock({ results: { ...ownCourse(), 'invite_links.insert': { data: { id: 'i', token: 't' }, error: null } } });
    await call({ action: 'create', course_id: COURSE, max_uses: -5 });
    expect(getSupabaseCalls('invite_links.insert')[0].payload.max_uses).toBe(null);
  });

  it('refuses a closing date that is not a date', async () => {
    const res = await call({ action: 'create', course_id: COURSE, expires_at: 'next Tuesday-ish' });
    expect(res.statusCode).toBe(400);
  });

  it('tries another token if the first one is already taken', async () => {
    configureSupabaseMock({ results: { 'invite_links.insert': [
      { data: null, error: { code: '23505', message: 'duplicate key' } },
      { data: { id: 'inv-1', token: 'SecondTry' }, error: null },
    ] } });

    const res = await call({ action: 'create', course_id: COURSE });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBe('SecondTry');
    expect(getSupabaseCalls('invite_links.insert')).toHaveLength(2);
  });

  it('gives up on a write failure that is not a collision', async () => {
    configureSupabaseMock({ results: {
      'invite_links.insert': { data: null, error: { code: '08006', message: 'connection failure' } },
    } });

    const res = await call({ action: 'create', course_id: COURSE });
    expect(res.statusCode).toBe(500);
    expect(getSupabaseCalls('invite_links.insert')).toHaveLength(1);
    expect(res.body.error).not.toMatch(/connection failure/);
  });
});

describe('who may use this at all', () => {
  it('lets an assistant with the students key in', async () => {
    asUser(ASSISTANT_USER);
    configureSupabaseMock({ results: {
      ...ownCourse(), 'invite_links.insert': { data: { id: 'i', token: 'tok1234567' }, error: null },
    } });
    expect((await call({ action: 'create', course_id: COURSE })).statusCode).toBe(200);
  });

  it('keeps an assistant without it out', async () => {
    asUser(ASSISTANT_USER, { profile: { staff_perms: ['courses'] } });
    const res = await call({ action: 'create', course_id: COURSE });
    expect(res.statusCode).toBe(403);
  });

  it('keeps students out', async () => {
    asUser(STUDENT_USER);
    const res = await call({ action: 'create', course_id: COURSE });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unknown action', async () => {
    const res = await call({ action: 'have_a_guess' });
    expect(res.statusCode).toBe(400);
  });
});

describe('opening, closing and deleting a link', () => {
  beforeEach(() => {
    configureSupabaseMock({ results: {
      'invite_links.select': { data: { id: 'inv-1', teacher_id: TEACHER_ID, token: 'tok', label: 'Sat 4pm' }, error: null },
    } });
  });

  it('closes one without deleting it', async () => {
    const res = await call({ action: 'set_open', invite_id: 'inv-1', is_open: false });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('invite_links.update')[0].payload).toEqual({ is_open: false });
    expect(getSupabaseCalls('invite_links.delete')).toHaveLength(0);
  });

  it('reopens one', async () => {
    await call({ action: 'set_open', invite_id: 'inv-1', is_open: true });
    expect(getSupabaseCalls('invite_links.update')[0].payload).toEqual({ is_open: true });
  });

  it('deletes one when asked', async () => {
    const res = await call({ action: 'delete', invite_id: 'inv-1' });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('invite_links.delete')[0].filters.id).toBe('inv-1');
  });

  it('will not touch a link in another teacher’s space', async () => {
    configureSupabaseMock({ results: {
      'invite_links.select': { data: { id: 'inv-9', teacher_id: OTHER_TEACHER_ID, token: 'tok' }, error: null },
    } });

    for (const body of [
      { action: 'set_open', invite_id: 'inv-9', is_open: false },
      { action: 'delete', invite_id: 'inv-9' },
    ]) {
      const res = await call(body);
      expect(res.statusCode).toBe(403);
    }
    expect(getSupabaseCalls('invite_links.update')).toHaveLength(0);
    expect(getSupabaseCalls('invite_links.delete')).toHaveLength(0);
  });

  it('says so when the link has gone', async () => {
    configureSupabaseMock({ results: { 'invite_links.select': { data: null, error: null } } });
    const res = await call({ action: 'delete', invite_id: 'inv-1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('approving a registration', () => {
  beforeEach(() => {
    configureSupabaseMock({ results: {
      ...withSubscription(),
      ...claimSucceeds(),
      'student_registrations.select': { data: REG, error: null },
      'courses.select': { data: [{ id: COURSE }], error: null },
      'groups.select': { data: [{ id: GROUP, course_id: COURSE }], error: null },
    } });
  });

  it('creates the account from what the student filled in', async () => {
    const res = await call({ action: 'approve', registration_id: 'reg-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body.password).toHaveLength(12);
    expect(res.body.email).toBe('sara@example.com');

    const [created] = getSupabaseCalls('auth.admin.createUser');
    expect(created.payload.app_metadata).toEqual({ role: 'student', teacher_id: TEACHER_ID });

    const [profile] = getSupabaseCalls('profiles.insert');
    expect(profile.payload).toMatchObject({
      teacher_id: TEACHER_ID, role: 'student', full_name: 'Sara Ahmed',
      email: 'sara@example.com', phone: '01012345678', must_change_pw: true,
    });
  });

  it('enrols them on the course and in the class the link was for', async () => {
    await call({ action: 'approve', registration_id: 'reg-1' });
    const [enrol] = getSupabaseCalls('enrollments.insert');
    expect(enrol.payload).toEqual([
      { teacher_id: TEACHER_ID, student_id: 'new-uid', course_id: COURSE, group_id: GROUP },
    ]);
  });

  it('claims the registration before creating anything', async () => {
    await call({ action: 'approve', registration_id: 'reg-1' });

    const [claim] = getSupabaseCalls('student_registrations.update');
    expect(claim.payload.status).toBe('approved');
    // Only a row still pending can be claimed — that is the whole lock.
    expect(claim.filters.status).toBe('pending');
    expect(claim.filters.id).toBe('reg-1');
  });

  it('records which account it became', async () => {
    await call({ action: 'approve', registration_id: 'reg-1' });
    const updates = getSupabaseCalls('student_registrations.update');
    expect(updates.some(u => u.payload.student_id === 'new-uid')).toBe(true);
  });

  it('stops when somebody else has just claimed it', async () => {
    configureSupabaseMock({ results: { 'student_registrations.update': { data: null, error: null } } });

    const res = await call({ action: 'approve', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('puts it back to pending when the account cannot be created', async () => {
    // A full plan is the ordinary way this happens, and the teacher has
    // to be able to buy a bigger one and try the same student again.
    configureSupabaseMock({ results: withSubscription({ student_limit: 1 }) });
    asUser(TEACHER_USER, { studentCount: 1 });
    configureSupabaseMock({ results: {
      ...claimSucceeds(),
      'student_registrations.select': { data: REG, error: null },
    } });

    const res = await call({ action: 'approve', registration_id: 'reg-1' });

    expect(res.statusCode).toBe(402);
    const rollback = getSupabaseCalls('student_registrations.update').pop();
    expect(rollback.payload).toMatchObject({ status: 'pending', reviewed_by: null, reviewed_at: null });
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('refuses one that is already approved', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': { data: { ...REG, status: 'approved' }, error: null },
    } });

    const res = await call({ action: 'approve', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already been approved/i);
    expect(getSupabaseCalls('student_registrations.update')).toHaveLength(0);
  });

  it('refuses one that was turned down', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': { data: { ...REG, status: 'rejected' }, error: null },
    } });

    const res = await call({ action: 'approve', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/register again/i);
  });

  it('explains itself when the course has since been deleted', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': { data: { ...REG, course_id: null }, error: null },
    } });

    const res = await call({ action: 'approve', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/deleted/i);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('will not approve a registration from another teacher’s space', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': { data: { ...REG, teacher_id: OTHER_TEACHER_ID }, error: null },
    } });

    const res = await call({ action: 'approve', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('says so when the registration has gone', async () => {
    configureSupabaseMock({ results: { 'student_registrations.select': { data: null, error: null } } });
    const res = await call({ action: 'approve', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('turning a registration down', () => {
  beforeEach(() => {
    configureSupabaseMock({ results: { 'student_registrations.select': { data: REG, error: null } } });
  });

  it('marks it rejected, which frees the email and number again', async () => {
    const res = await call({ action: 'reject', registration_id: 'reg-1', note: 'Duplicate of Sara A.' });

    expect(res.statusCode).toBe(200);
    const [update] = getSupabaseCalls('student_registrations.update');
    expect(update.payload).toMatchObject({ status: 'rejected', review_note: 'Duplicate of Sara A.' });
    expect(update.filters.id).toBe('reg-1');
  });

  it('creates nothing', async () => {
    await call({ action: 'reject', registration_id: 'reg-1' });
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
    expect(getSupabaseCalls('profiles.insert')).toHaveLength(0);
  });

  it('will not turn down somebody who already has an account', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': { data: { ...REG, status: 'approved' }, error: null },
    } });

    const res = await call({ action: 'reject', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/students list/i);
    expect(getSupabaseCalls('student_registrations.update')).toHaveLength(0);
  });

  it('will not touch one in another teacher’s space', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': { data: { ...REG, teacher_id: OTHER_TEACHER_ID }, error: null },
    } });

    const res = await call({ action: 'reject', registration_id: 'reg-1' });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('student_registrations.update')).toHaveLength(0);
  });
});

describe('the method', () => {
  it('is POST only', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });
});

// Parent details became required on a student a teacher types in, and on
// one registering through a link today. A registration taken BEFORE that
// has neither, and it is sitting in a queue the teacher cannot empty any
// other way — so the rule lives in api/students.js and api/join.js, not
// in the createStudentAccount() all three share. Approving an old one
// has to keep working.
describe('approving a registration taken before parent details were asked for', () => {
  it('still creates the account', async () => {
    const src = readFileSync(new URL('../../api/_lib/students.js', import.meta.url), 'utf8');
    expect(src, 'createStudentAccount() now refuses a student with no parent details, '
      + 'which strands every registration taken before they were asked for')
      .not.toMatch(/parent.{0,40}(is required|required\.)/i);
  });
});
