import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, ASSISTANT_USER, STUDENT_USER, OWNER_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser, withSubscription } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/students.js';

const COURSE = 'course-1';

// A parent's phone and email are required on a new student, the same as
// on one who registers themselves through a batch link.
const PARENT = { parent_phone: '+20 100 000 1111', parent_email: 'parent@example.com' };

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
    const res = await call({ ...PARENT, full_name: 'Sara Ahmed', email: 'Sara@Example.com', course_ids: [COURSE] });

    expect(res.statusCode).toBe(200);
    // A link to set a password, never a password. Nobody — not even the
    // teacher who made the account — is told one.
    expect(res.body).not.toHaveProperty('password');
    expect(res.body.invite_url).toMatch(/\/setup\/[A-Za-z0-9]+$/);
    expect(res.body.email).toBe('sara@example.com');

    const [created] = getSupabaseCalls('auth.admin.createUser');
    // These two claims are what row-level security reads. If they are ever
    // wrong or missing, the new student can see another teacher's space.
    expect(created.payload.app_metadata).toEqual({ role: 'student', teacher_id: TEACHER_ID });

    const [profile] = getSupabaseCalls('profiles.insert');
    expect(profile.payload).toMatchObject({ teacher_id: TEACHER_ID, role: 'student', must_change_pw: true });

    const [enrol] = getSupabaseCalls('enrollments.insert');
    expect(enrol.payload).toEqual([{ teacher_id: TEACHER_ID, student_id: 'new-uid', course_id: COURSE, group_id: null }]);
  });

  it('puts them in the group that was chosen for that course', async () => {
    configureSupabaseMock({ results: {
      'groups.select': { data: [{ id: 'grp-1', course_id: COURSE }], error: null },
    } });

    const res = await call({
      ...PARENT, full_name: 'Sara Ahmed', email: 'sara@example.com',
      course_ids: [COURSE], group_ids: { [COURSE]: 'grp-1' },
    });

    expect(res.statusCode).toBe(200);
    const [enrol] = getSupabaseCalls('enrollments.insert');
    expect(enrol.payload[0].group_id).toBe('grp-1');
  });

  it('refuses a group belonging to a different course', async () => {
    // The database would refuse this too — the foreign key is on the
    // pair — but a teacher deserves to be told which half was wrong.
    configureSupabaseMock({ results: {
      'groups.select': { data: [{ id: 'grp-1', course_id: 'course-9' }], error: null },
    } });

    const res = await call({
      ...PARENT, full_name: 'Sara Ahmed', email: 'sara@example.com',
      course_ids: [COURSE], group_ids: { [COURSE]: 'grp-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/different course/i);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('refuses a group from another teacher’s space', async () => {
    configureSupabaseMock({ results: { 'groups.select': { data: [], error: null } } });

    const res = await call({
      ...PARENT, full_name: 'Sara Ahmed', email: 'sara@example.com',
      course_ids: [COURSE], group_ids: { [COURSE]: 'grp-elsewhere' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not in your space/i);
  });

  it('ignores a group named for a course they are not being enrolled on', async () => {
    const res = await call({
      ...PARENT, full_name: 'Sara Ahmed', email: 'sara@example.com',
      course_ids: [COURSE], group_ids: { 'course-9': 'grp-9' },
    });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('groups.select')).toHaveLength(0);
    const [enrol] = getSupabaseCalls('enrollments.insert');
    expect(enrol.payload[0].group_id).toBe(null);
  });

  it('ignores a teacher_id in the request body', async () => {
    const res = await call({
      full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE],
      teacher_id: OTHER_TEACHER_ID,
    });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('insists on a parent’s phone', async () => {
    const res = await call({
      ...PARENT, parent_phone: '',
      full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/parent/i);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('insists on a parent’s email', async () => {
    const res = await call({
      ...PARENT, parent_email: '',
      full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/parent/i);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('insists a parent’s email is a real address', async () => {
    const res = await call({
      ...PARENT, parent_email: 'dad',
      full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a course that belongs to someone else', async () => {
    configureSupabaseMock({ results: courseLookup([]) });   // the tenant filter finds nothing
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: ['someone-elses-course'] });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('needs at least one course', async () => {
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an email that is not one', async () => {
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'not-an-email', course_ids: [COURSE] });
    expect(res.statusCode).toBe(400);
  });

  it('says so when the address is already taken', async () => {
    configureSupabaseMock({
      results: { 'auth.admin.listUsers': { data: { users: [{ email: 'sara@example.com' }] }, error: null } },
    });
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('deletes the auth user again when the profile insert fails', async () => {
    configureSupabaseMock({ results: { 'profiles.insert': { data: null, error: { message: 'boom' } } } });
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });

    expect(res.statusCode).toBe(500);
    // A student who can sign in but has no profile cannot be helped by
    // anyone, so the half-made account must not survive.
    expect(getSupabaseCalls('auth.admin.deleteUser')[0].payload.id).toBe('new-uid');
  });

  it('deletes the auth user again when the enrolment fails', async () => {
    configureSupabaseMock({ results: { 'enrollments.insert': { data: null, error: { message: 'boom' } } } });
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });

    expect(res.statusCode).toBe(500);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(1);
  });
});

describe('the plan limit', () => {
  beforeEach(() => { configureSupabaseMock({ results: courseLookup() }); });

  it('refuses once every place is used', async () => {
    asUser(TEACHER_USER, { studentCount: 60 });
    configureSupabaseMock({ results: withSubscription({ student_limit: 60 }) });

    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toMatch(/60 students/);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('allows the last place', async () => {
    asUser(TEACHER_USER, { studentCount: 59 });
    configureSupabaseMock({ results: withSubscription({ student_limit: 60 }) });

    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(200);
  });

  it('pauses new accounts while a subscription is past due', async () => {
    configureSupabaseMock({ results: withSubscription({ status: 'past_due' }) });
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
    expect(res.statusCode).toBe(402);
    expect(res.body.error).toMatch(/past due/i);
  });

  it('refuses when there is no subscription at all', async () => {
    configureSupabaseMock({ results: { 'subscriptions.select': { data: null, error: null } } });
    const res = await call({ ...PARENT, full_name: 'Sara', email: 'sara@example.com', course_ids: [COURSE] });
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

  it('resets by sending a link, not by handing over a password', async () => {
    const res = await call({ action: 'reset_password', student_id: 'stu-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty('password');
    expect(res.body.invite_url).toMatch(/\/setup\/[A-Za-z0-9]+$/);

    // The old password stops working now, not when the link is opened.
    // A teacher pressing this is often doing it because somebody should
    // not be getting in.
    const [pw] = getSupabaseCalls('auth.admin.updateUserById');
    expect(pw.payload.password).toHaveLength(32);

    const [update] = getSupabaseCalls('profiles.update');
    expect(update.payload).toEqual({ must_change_pw: true });
  });

  it('will not touch a student in another tenant', async () => {
    for (const action of ['reset_password', 'remind_password', 'set_active', 'delete']) {
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

  // A student who never sets their own password is still signing in with
  // the one that was handed to them. The reminder is the only nudge there
  // is, and it cannot carry a password — none is stored to send.
  describe('reminding them to set their own password', () => {
    const waiting = { ...mine, must_change_pw: true };
    const done    = { ...mine, id: 'stu-3', must_change_pw: false };

    function withMail() {
      process.env.BREVO_API_KEY = 'xkeysib-test';
      process.env.BREVO_SENDER_EMAIL = 'hello@example.com';
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messageId: '1' }) }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    afterEach(() => {
      delete process.env.BREVO_API_KEY;
      delete process.env.BREVO_SENDER_EMAIL;
      vi.unstubAllGlobals();
    });

    it('emails one student a link, with no password in it', async () => {
      asUser(TEACHER_USER, { extraProfiles: { 'stu-1': waiting } });
      const fetchMock = withMail();

      const res = await call({ action: 'remind_password', student_id: 'stu-1' });

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ sent: 1, skipped: [] });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual([{ email: 'sara@example.com', name: 'Sara' }]);
      // A link to set one, and no password anywhere in it — there is
      // none to send, which is the point of the whole flow.
      expect(body.htmlContent).toMatch(/\/setup\/[A-Za-z0-9]+/);
      expect(res.body.invite_url).toMatch(/\/setup\/[A-Za-z0-9]+$/);
    });

    it('leaves alone a student who has already chosen one', async () => {
      asUser(TEACHER_USER, { extraProfiles: { 'stu-3': done } });
      const fetchMock = withMail();

      const res = await call({ action: 'remind_password', student_id: 'stu-3' });

      expect(res.body.sent).toBe(0);
      expect(res.body.skipped[0].why).toMatch(/already chosen/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reminds a whole list, and says who was left out', async () => {
      asUser(TEACHER_USER, { extraProfiles: { 'stu-1': waiting, 'stu-3': done, 'stu-2': theirs } });
      const fetchMock = withMail();

      const res = await call({
        action: 'remind_password', student_ids: ['stu-1', 'stu-3', 'stu-2'],
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.sent).toBe(1);
      // One has done it already; one is not this teacher's to email. A bad
      // id in the list must not throw the rest of the class away.
      expect(res.body.skipped).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a mail provider that refuses, rather than claiming a send', async () => {
      asUser(TEACHER_USER, { extraProfiles: { 'stu-1': waiting } });
      process.env.BREVO_API_KEY = 'xkeysib-test';
      process.env.BREVO_SENDER_EMAIL = 'hello@example.com';
      vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({ message: 'sender not verified' }) }));
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await call({ action: 'remind_password', student_id: 'stu-1' });

      expect(res.body.sent).toBe(0);
      expect(res.body.skipped[0].why).toMatch(/sender not verified/);
      quiet.mockRestore();
    });
  });

  it('releases their registration when the account is deleted', async () => {
    // The registration row outlives the account — student_id is SET
    // NULL, not CASCADE — and while it stands it holds that email and
    // that number inside the "register once" indexes. A student deleted
    // by mistake could never register again: the link told them they
    // had already registered, and to wait for details nobody was
    // sending.
    configureSupabaseMock({ results: {
      ...withSubscription(),
      'student_registrations.select': { data: [{ id: 'reg-1' }], error: null },
    } });

    const res = await call({ action: 'delete', student_id: 'stu-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body.released).toBe(1);

    const [released] = getSupabaseCalls('student_registrations.update');
    expect(released, 'the registration was left holding the email').toBeTruthy();
    // 'rejected' is the one status both unique indexes exclude, which is
    // what actually frees the pair.
    expect(released.payload.status).toBe('rejected');

    // Found before the account went, and by every key the door checks:
    // the row itself, the address, and both numbers. A student whose
    // email was corrected after they registered is held by the number
    // alone, and matching only the address would leave them locked out.
    const looked = getSupabaseCalls('student_registrations.select')
      .map(c => c.filters);
    expect(looked.some(f => f.student_id === 'stu-1'), 'not matched by row').toBe(true);
    expect(looked.some(f => f.email_key === 'sara@example.com'), 'not matched by email').toBe(true);
    expect(looked.every(f => f['neq:status'] === 'rejected')).toBe(true);
  });

  it('releases a registration held by the number, not just the address', async () => {
    // The case that locks somebody out quietly: they registered, the
    // teacher corrected a typo in their email afterwards, and the row
    // now matches on nothing but the phone. Matching only the address
    // would delete the account and leave the number holding the door.
    asUser(TEACHER_USER, { extraProfiles: { 'stu-1': {
      ...mine, email: 'corrected@example.com', phone: '+20 101 234 5678', parent_phone: '+20 100 000 1111',
    } } });
    configureSupabaseMock({ results: {
      ...withSubscription(),
      'student_registrations.select': { data: [{ id: 'reg-1' }], error: null },
    } });

    await call({ action: 'delete', student_id: 'stu-1' });

    const looked = getSupabaseCalls('student_registrations.select').map(c => c.filters);
    // The last nine digits are what the unique index is built on, so
    // they are what has to be searched for — both numbers, because
    // either can be the one on the row.
    expect(looked.some(f => f.phone_key === '012345678'), 'their own number').toBe(true);
    expect(looked.some(f => f.phone_key === '000001111'), "the parent's number").toBe(true);
  });

  it('refuses an account that is not a student', async () => {
    asUser(TEACHER_USER, {
      extraProfiles: { 'asst-1': { id: 'asst-1', role: 'assistant', teacher_id: TEACHER_ID, full_name: 'X' } },
    });
    const res = await call({ action: 'delete', student_id: 'asst-1' });
    expect(res.statusCode).toBe(400);
  });
});

describe('editing a student', () => {
  const mine = {
    id: 'stu-1', full_name: 'Sara', email: 'sara@example.com', role: 'student',
    teacher_id: TEACHER_ID, is_active: true,
    phone: '0100', parent_phone: '0111', parent_email: 'mum@example.com',
  };

  beforeEach(() => {
    asUser(TEACHER_USER, { extraProfiles: { 'stu-1': mine } });
  });

  it('saves the details a teacher can correct', async () => {
    const res = await call({
      action: 'update', student_id: 'stu-1',
      full_name: 'Sara Ahmed', phone: '0102', parent_phone: '0111',
      parent_email: 'Dad@Example.com',
    });

    expect(res.statusCode).toBe(200);
    const [update] = getSupabaseCalls('profiles.update');
    expect(update.filters.id).toBe('stu-1');
    expect(update.payload).toEqual({
      full_name: 'Sara Ahmed', phone: '0102', parent_email: 'dad@example.com',
    });
    // The parent phone came back the same, so it is not in the patch.
    expect(res.body.changed).not.toContain('parent phone');
  });

  it('lets a parent email that was typed wrong be cleared', async () => {
    const res = await call({ action: 'update', student_id: 'stu-1', parent_email: '' });

    expect(res.statusCode).toBe(200);
    const [update] = getSupabaseCalls('profiles.update');
    expect(update.payload).toEqual({ parent_email: null });
  });

  it('leaves fields the form did not send alone', async () => {
    await call({ action: 'update', student_id: 'stu-1', full_name: 'Sara Ahmed' });

    const [update] = getSupabaseCalls('profiles.update');
    expect(update.payload).toEqual({ full_name: 'Sara Ahmed' });
  });

  it('writes nothing at all when nothing actually changed', async () => {
    const res = await call({
      action: 'update', student_id: 'stu-1',
      full_name: 'Sara', phone: '0100', parent_phone: '0111',
      parent_email: 'mum@example.com', email: 'sara@example.com',
    });

    expect(res.body).toEqual({ ok: true, changed: [] });
    expect(getSupabaseCalls('profiles.update')).toHaveLength(0);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
  });

  it('moves the sign-in email in both places and tells the student', async () => {
    const res = await call({ action: 'update', student_id: 'stu-1', email: 'Sara.New@Example.com' });

    expect(res.statusCode).toBe(200);
    const [auth] = getSupabaseCalls('auth.admin.updateUserById');
    expect(auth.payload).toEqual({ id: 'stu-1', email: 'sara.new@example.com', email_confirm: true });

    const [update] = getSupabaseCalls('profiles.update');
    expect(update.payload).toEqual({ email: 'sara.new@example.com' });
    expect(res.body.changed).toContain('sign-in email');
  });

  it('refuses an email that belongs to somebody else', async () => {
    configureSupabaseMock({ results: {
      'auth.admin.listUsers': { data: { users: [{ id: 'someone-else', email: 'taken@example.com' }] }, error: null },
    } });

    const res = await call({ action: 'update', student_id: 'stu-1', email: 'taken@example.com' });

    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
    expect(getSupabaseCalls('profiles.update')).toHaveLength(0);
  });

  it('puts the sign-in back when the profile write then fails', async () => {
    // Otherwise the student is left signing in with an address their
    // teacher cannot see on the page in front of them.
    configureSupabaseMock({ results: {
      'profiles.update': { data: null, error: { message: 'nope' } },
    } });

    const res = await call({ action: 'update', student_id: 'stu-1', email: 'sara.new@example.com' });

    expect(res.statusCode).toBe(500);
    const rollback = getSupabaseCalls('auth.admin.updateUserById');
    expect(rollback).toHaveLength(2);
    expect(rollback[1].payload.email).toBe('sara@example.com');
  });

  it('will not edit a student in another tenant', async () => {
    asUser(TEACHER_USER, { extraProfiles: { 'stu-2': { ...mine, id: 'stu-2', teacher_id: OTHER_TEACHER_ID } } });
    const res = await call({ action: 'update', student_id: 'stu-2', full_name: 'Hacked' });

    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('profiles.update')).toHaveLength(0);
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
    const res = await call({ ...PARENT, full_name: 'Nour Hassan', email: 'nour@example.com', course_ids: [COURSE] });
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
