import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { withSubscription } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/join.js';

// api/join.js is the only handler with no signed-in caller, so these
// tests never sign anyone in. Everything it is allowed to do has to come
// off the invite row the token resolves to.

const TOKEN = 'AbC123xyZ9';
const INVITE = {
  id: 'inv-1', teacher_id: TEACHER_ID, course_id: 'course-1', group_id: 'grp-1',
  is_open: true, expires_at: null, max_uses: null,
};

// A clean space: nobody registered, nobody enrolled.
function emptySpace() {
  return {
    'student_registrations.select': { data: [], error: null },
    'profiles.select': { data: [], error: null },
  };
}

// Registering now makes the account in the same request, so a submit
// reads courses and groups TWICE and wants a different shape each time:
// once to name the class on the page, once to check the enrolment is
// this teacher's own. The mock consumes a list in call order, so both
// shapes are queued. An info request only ever takes the first.
function withInvite(overrides = {}) {
  return {
    'invite_links.select': { data: { ...INVITE, ...overrides }, error: null },
    'teachers.select': { data: { display_name: 'Miss Noura' }, error: null },
    'courses.select': [
      { data: { title: 'SAT Math' }, error: null },                       // for the page
      { data: [{ id: INVITE.course_id }], error: null },                  // for the enrolment
    ],
    'groups.select': [
      { data: { name: 'Saturday 4pm', days: [6], start_time: '16:00' }, error: null },
      { data: [{ id: INVITE.group_id, course_id: INVITE.course_id }], error: null },
    ],
  };
}

// The registration row is written before the account and read back for
// its id, and the account itself needs a plan with room on it.
function canMakeAccounts() {
  return {
    ...withSubscription(),
    'student_registrations.insert': { data: { id: 'reg-1' }, error: null },
  };
}

const GOOD = {
  action: 'submit',
  full_name: 'Sara Ahmed',
  email: 'Sara@Example.com',
  phone: '+20 101 234 5678',
};

// The "have we seen this person" queries, as opposed to the head/count
// one the burst guard makes against the same table.
function duplicateLookups() {
  return getSupabaseCalls('student_registrations.select').filter(c => !c.opts?.count);
}

async function call(body) {
  const res = makeRes();
  // No Authorization header: a student registering has no account yet.
  await handler(makeReq({ body, token: null }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  configureSupabaseMock({ results: { ...withInvite(), ...emptySpace(), ...canMakeAccounts() } });
});

describe('what the link shows before anything is typed', () => {
  it('names the space, the course and the class', async () => {
    const res = await call({ token: TOKEN });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      space_name: 'Miss Noura',
      course_title: 'SAT Math',
      group: { name: 'Saturday 4pm', days: [6], start_time: '16:00' },
    });
  });

  it('gives away nothing else about the space', async () => {
    const res = await call({ token: TOKEN });
    // No ids, no counts, no student list. Whoever holds the link is a
    // stranger until they register.
    expect(Object.keys(res.body).sort()).toEqual(['course_title', 'group', 'space_name']);
    expect(JSON.stringify(res.body)).not.toContain(TEACHER_ID);
  });

  it('looks the token up by its exact value', async () => {
    await call({ token: TOKEN });
    const [lookup] = getSupabaseCalls('invite_links.select');
    expect(lookup.filters.token).toBe(TOKEN);
  });
});

describe('a link that is not taking registrations', () => {
  // Every one of these says the same thing, on purpose: somebody probing
  // tokens should not learn which kind of "no" they hit.
  const SAME = /not taking new students/i;

  it('refuses an unknown token', async () => {
    configureSupabaseMock({ results: { 'invite_links.select': { data: null, error: null } } });
    const res = await call({ token: 'nope' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(SAME);
  });

  it('refuses a missing token without going near the database', async () => {
    const res = await call({ token: '' });
    expect(res.statusCode).toBe(404);
    expect(getSupabaseCalls('invite_links.select')).toHaveLength(0);
  });

  it('refuses a closed link', async () => {
    configureSupabaseMock({ results: withInvite({ is_open: false }) });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(SAME);
  });

  it('refuses an expired link', async () => {
    configureSupabaseMock({ results: withInvite({ expires_at: '2020-01-01T00:00:00Z' }) });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(404);
  });

  it('accepts one whose closing date has not arrived', async () => {
    const later = new Date(Date.now() + 86_400_000).toISOString();
    configureSupabaseMock({ results: withInvite({ expires_at: later }) });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(200);
  });

  it('refuses one that has taken as many as it was told to', async () => {
    configureSupabaseMock({ results: {
      ...withInvite({ max_uses: 30 }),
      'student_registrations.select': { data: null, error: null, count: 30 },
    } });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(404);
  });

  it('counts turned-down registrations as not taking up a place', async () => {
    configureSupabaseMock({ results: withInvite({ max_uses: 30 }) });
    await call({ token: TOKEN });
    const [count] = getSupabaseCalls('student_registrations.select');
    expect(count.filters['neq:status']).toBe('rejected');
  });

  it('writes nothing when the link is closed', async () => {
    configureSupabaseMock({ results: withInvite({ is_open: false }) });
    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(404);
    expect(getSupabaseCalls('student_registrations.insert')).toHaveLength(0);
  });
});

describe('registering', () => {
  it('saves the details against the invite’s own tenant, course and group', async () => {
    const res = await call({ ...GOOD, token: TOKEN, parent_phone: '0111 111 1111' });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const [saved] = getSupabaseCalls('student_registrations.insert');
    expect(saved.payload).toMatchObject({
      teacher_id: TEACHER_ID,
      invite_id: 'inv-1',
      course_id: 'course-1',
      group_id: 'grp-1',
      full_name: 'Sara Ahmed',
      email: 'sara@example.com',
      name_flag: false,
    });
  });

  it('ignores a tenant, course or group named in the request', async () => {
    // The body is written by a stranger. If any of this were read from
    // it, the link would enrol people anywhere.
    await call({
      ...GOOD, token: TOKEN,
      teacher_id: OTHER_TEACHER_ID, course_id: 'course-9', group_id: 'grp-9', status: 'rejected',
    });

    const [saved] = getSupabaseCalls('student_registrations.insert');
    expect(saved.payload.teacher_id).toBe(TEACHER_ID);
    expect(saved.payload.course_id).toBe('course-1');
    expect(saved.payload.group_id).toBe('grp-1');
    // The handler decides the status, so a body asking to be rejected —
    // or approved — changes nothing.
    expect(saved.payload.status).toBe('approved');
  });

  it('creates the account there and then', async () => {
    const res = await call({ ...GOOD, token: TOKEN });

    expect(res.statusCode).toBe(200);
    const [created] = getSupabaseCalls('auth.admin.createUser');
    // The two claims row-level security reads. Wrong here and the new
    // student can see another teacher's space.
    expect(created.payload.app_metadata).toEqual({ role: 'student', teacher_id: TEACHER_ID });

    const [profile] = getSupabaseCalls('profiles.insert');
    expect(profile.payload).toMatchObject({ teacher_id: TEACHER_ID, role: 'student', must_change_pw: true });
  });

  it('enrols them on the invite\u2019s own course and group', async () => {
    await call({ ...GOOD, token: TOKEN, course_id: 'course-9', group_id: 'grp-9' });

    const [enrol] = getSupabaseCalls('enrollments.insert');
    expect(enrol.payload).toEqual([{
      teacher_id: TEACHER_ID, student_id: 'new-uid', course_id: 'course-1', group_id: 'grp-1',
    }]);
  });

  it('hands the sign-in straight back to the student', async () => {
    // They are holding a phone at this moment and may never open the
    // email. The password goes on the screen as well as into the inbox.
    const res = await call({ ...GOOD, token: TOKEN });

    expect(res.body.email).toBe('sara@example.com');
    expect(res.body.password).toHaveLength(12);
    expect(res.body).toHaveProperty('email_sent');
  });

  it('records which account the registration became', async () => {
    await call({ ...GOOD, token: TOKEN });
    const [update] = getSupabaseCalls('student_registrations.update');
    expect(update.payload).toEqual({ student_id: 'new-uid' });
  });

  it('nobody reviewed it, so nobody is recorded as having', async () => {
    await call({ ...GOOD, token: TOKEN });
    const [saved] = getSupabaseCalls('student_registrations.insert');
    expect(saved.payload.reviewed_by).toBeUndefined();
    expect(saved.payload.reviewed_at).toEqual(expect.any(String));
  });
});

describe('when the account cannot be made', () => {
  // A plan that is full, a subscription past due, a space with no
  // subscription at all: every one of those is the teacher's business,
  // and the person reading the answer is a stranger holding a link.
  beforeEach(() => {
    configureSupabaseMock({ results: {
      ...withInvite(), ...emptySpace(), ...canMakeAccounts(),
      ...withSubscription({ status: 'past_due' }),
    } });
  });

  it('tells the student nothing about the teacher\u2019s billing', async () => {
    const res = await call({ ...GOOD, token: TOKEN });

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/tell them you tried to register/i);
    expect(res.body.error).not.toMatch(/subscription|invoice|past due|plan|limit/i);
  });

  it('takes the registration row back out', async () => {
    // It was the lock that stops two taps becoming two accounts, not a
    // record of anything that happened. Leaving it would bar the student
    // from ever trying again.
    await call({ ...GOOD, token: TOKEN });
    expect(getSupabaseCalls('student_registrations.delete')).toHaveLength(1);
  });

  it('insists on a mobile number', async () => {
    const res = await call({ ...GOOD, token: TOKEN, phone: '' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/mobile number/i);
    expect(getSupabaseCalls('student_registrations.insert')).toHaveLength(0);
  });

  it('rejects a number too short to identify anybody', async () => {
    const res = await call({ ...GOOD, token: TOKEN, phone: '123' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a name or email that is not one', async () => {
    expect((await call({ ...GOOD, token: TOKEN, email: 'not-an-email' })).statusCode).toBe(400);
    expect((await call({ ...GOOD, token: TOKEN, full_name: 'X' })).statusCode).toBe(400);
  });
});

describe('registering only once', () => {
  it('turns away an email that has already registered', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': (c) =>
        ({ data: c.filters.email_key === 'sara@example.com' ? [{ id: 'reg-1' }] : [], error: null }),
    } });

    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
    expect(getSupabaseCalls('student_registrations.insert')).toHaveLength(0);
  });

  it('turns away the same number written a different way', async () => {
    // +20 101 234 5678 and 01012345678 are one person and one phone.
    configureSupabaseMock({ results: {
      'student_registrations.select': (c) =>
        ({ data: c.filters.phone_key === '012345678' ? [{ id: 'reg-1' }] : [], error: null }),
    } });

    const res = await call({ ...GOOD, token: TOKEN, email: 'different@example.com', phone: '01012345678' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('lets somebody who was turned down register again', async () => {
    await call({ ...GOOD, token: TOKEN });
    // Both lookups exclude rejected rows, which is what releases the
    // email and the number for a second attempt.
    const lookups = duplicateLookups();
    expect(lookups.length).toBe(2);   // one for the email, one for the number
    for (const l of lookups) expect(l.filters['neq:status']).toBe('rejected');
  });

  it('looks only inside this teacher’s space', async () => {
    await call({ ...GOOD, token: TOKEN });
    for (const l of duplicateLookups()) {
      expect(l.filters.teacher_id).toBe(TEACHER_ID);
    }
  });

  it('sends somebody who already has an account to sign in instead', async () => {
    configureSupabaseMock({ results: {
      'profiles.select': { data: [{ full_name: 'Sara Ahmed', email: 'sara@example.com' }], error: null },
    } });

    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already have an account/i);
    expect(res.body.error).toMatch(/forgot password/i);
  });

  it('matches an existing student by phone however it was typed', async () => {
    configureSupabaseMock({ results: {
      'profiles.select': { data: [{ full_name: 'Someone Else', email: 'x@example.com', phone: '0101-234-5678' }], error: null },
    } });

    const res = await call({ ...GOOD, token: TOKEN, email: 'brand-new@example.com' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already have an account/i);
  });

  it('matches a parent’s number too', async () => {
    configureSupabaseMock({ results: {
      'profiles.select': { data: [{ full_name: 'A Sibling', email: 'x@example.com', parent_phone: '+201012345678' }], error: null },
    } });

    const res = await call({ ...GOOD, token: TOKEN, email: 'brand-new@example.com' });
    expect(res.statusCode).toBe(409);
  });

  // The index in migration v11 is what decides a race; this is the
  // handler being civil about losing one.
  it('answers a duplicate that slipped past the checks with the same sentence', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.insert': { data: null, error: { code: '23505', message: 'duplicate key' } },
    } });

    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it('does not dress up an ordinary write failure as a duplicate', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.insert': { data: null, error: { code: '08006', message: 'connection failure' } },
    } });

    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(500);
    expect(res.body.error).not.toMatch(/already registered/i);
    expect(res.body.error).not.toMatch(/connection failure/);
  });
});

describe('a link being used as a hose', () => {
  it('stops a flood of invented registrations', async () => {
    configureSupabaseMock({ results: {
      'student_registrations.select': (c) =>
        // The burst count is the head/count query; the duplicate lookups
        // that follow are ordinary selects.
        (c.opts?.count ? { data: null, error: null, count: 40 } : { data: [], error: null }),
    } });

    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(429);
    expect(getSupabaseCalls('student_registrations.insert')).toHaveLength(0);
  });

  it('lets an ordinary class register together', async () => {
    // Thirty students in the minute after the message lands is the
    // normal case, not the suspicious one.
    configureSupabaseMock({ results: {
      'student_registrations.select': (c) =>
        (c.opts?.count ? { data: null, error: null, count: 30 } : { data: [], error: null }),
    } });

    const res = await call({ ...GOOD, token: TOKEN });
    expect(res.statusCode).toBe(200);
  });

  it('counts only that link, and only recently', async () => {
    await call({ ...GOOD, token: TOKEN });
    const burst = getSupabaseCalls('student_registrations.select').find(c => c.opts?.count);
    expect(burst.filters.invite_id).toBe('inv-1');
    expect(new Date(burst.filters['gt:submitted_at']).getTime())
      .toBeGreaterThan(Date.now() - 11 * 60 * 1000);
  });
});

describe('a name that is already in the space', () => {
  it('is flagged for the teacher, not refused', async () => {
    configureSupabaseMock({ results: {
      'profiles.select': { data: [{ full_name: 'sara   AHMED', email: 'other@example.com', phone: '0999999999' }], error: null },
    } });

    const res = await call({ ...GOOD, token: TOKEN });

    // Two real students share a name often enough that this must not be
    // a locked door.
    expect(res.statusCode).toBe(200);
    const [saved] = getSupabaseCalls('student_registrations.insert');
    expect(saved.payload.name_flag).toBe(true);
  });

  it('is compared without being read as a pattern', async () => {
    // '%' is a wildcard to the database and nothing at all to a person.
    configureSupabaseMock({ results: {
      'profiles.select': { data: [{ full_name: 'Sara Ahmed', email: 'other@example.com', phone: '0999999999' }], error: null },
    } });

    const res = await call({ ...GOOD, token: TOKEN, full_name: '%' });
    expect(res.statusCode).toBe(400);   // too short to be a name at all

    const res2 = await call({ ...GOOD, token: TOKEN, full_name: '%a%' });
    expect(res2.statusCode).toBe(200);
    const saved = getSupabaseCalls('student_registrations.insert').pop();
    expect(saved.payload.name_flag).toBe(false);
  });
});

describe('what a stranger can put in a query', () => {
  it('never builds a filter out of what they typed', async () => {
    // cleanEmail permits a comma, and a comma is how PostgREST separates
    // conditions — so an interpolated filter string here would let this
    // body add conditions of its own. Every comparison has to arrive as
    // one bound value, whatever is inside it.
    const hostile = 'a,phone_key.eq.012345678@example.com';
    await call({ ...GOOD, token: TOKEN, email: hostile });

    const byEmail = getSupabaseCalls('student_registrations.select')
      .filter(c => 'email_key' in c.filters);
    expect(byEmail).toHaveLength(1);

    // The whole string, still in one piece and still in one column.
    expect(byEmail[0].filters.email_key).toBe(hostile);
    expect(Object.keys(byEmail[0].filters).sort())
      .toEqual(['email_key', 'neq:status', 'teacher_id']);

    // And no operator ever went into a column name.
    for (const c of getSupabaseCalls()) {
      for (const col of Object.keys(c.filters || {})) expect(col).not.toMatch(/[,(]/);
    }
  });
});

describe('the method', () => {
  it('is POST only', async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'GET', token: null }), res);
    expect(res.statusCode).toBe(405);
  });
});
