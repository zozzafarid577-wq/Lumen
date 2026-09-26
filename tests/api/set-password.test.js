import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls, TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/set-password.js';

// The second handler with no signed-in caller: a student opening a
// set-up link has no password yet, which is what they are here to fix.
// The token is the only credential, so these tests never sign anyone in
// and check that nothing in a request body can stand in for it.

const TOKEN = 'AbC123xyZ9kLmN01';
const STUDENT = {
  id: 'stu-1', full_name: 'Sara Ahmed', email: 'sara@example.com',
  role: 'student', is_active: true, teacher_id: TEACHER_ID,
};

const hourFromNow = () => new Date(Date.now() + 3600e3).toISOString();
const hourAgo = () => new Date(Date.now() - 3600e3).toISOString();

function withInvite(overrides = {}) {
  return {
    'password_invites.select': {
      data: {
        token: TOKEN, student_id: STUDENT.id, teacher_id: TEACHER_ID,
        expires_at: hourFromNow(), used_at: null, ...overrides,
      },
      error: null,
    },
    'profiles.select': { data: STUDENT, error: null },
    'teachers.select': { data: { display_name: 'Miss Noura' }, error: null },
  };
}

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body, token: null }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  configureSupabaseMock({ results: withInvite() });
});

describe('what the link shows before anything is typed', () => {
  it('names them, their address and whose space it is', async () => {
    const res = await call({ token: TOKEN });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      full_name: 'Sara Ahmed',
      email: 'sara@example.com',
      space_name: 'Miss Noura',
    });
  });

  it('gives away nothing else', async () => {
    // Everything here is already known to whoever holds the link, because
    // it was sent to them. Ids and anything about anybody else are not.
    const res = await call({ token: TOKEN });
    expect(Object.keys(res.body).sort()).toEqual(['email', 'full_name', 'space_name']);
  });
});

describe('a link that cannot be used', () => {
  it('refuses one that does not exist', async () => {
    configureSupabaseMock({ results: { 'password_invites.select': { data: null, error: null } } });
    const res = await call({ token: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses one already spent, and says so', async () => {
    // A student who taps the same WhatsApp message twice should be told
    // they have already done this, not that their link was never real.
    configureSupabaseMock({ results: withInvite({ used_at: hourAgo() }) });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(410);
    expect(res.body.error).toMatch(/already been used/i);
  });

  it('refuses one that has expired', async () => {
    configureSupabaseMock({ results: withInvite({ expires_at: hourAgo() }) });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('refuses one belonging to a paused account', async () => {
    configureSupabaseMock({
      results: { ...withInvite(), 'profiles.select': { data: { ...STUDENT, is_active: false }, error: null } },
    });
    const res = await call({ token: TOKEN });
    expect(res.statusCode).toBe(403);
  });

  it('will not set a password on an account that is not a student', async () => {
    configureSupabaseMock({
      results: { ...withInvite(), 'profiles.select': { data: { ...STUDENT, role: 'teacher' }, error: null } },
    });
    const res = await call({ action: 'submit', token: TOKEN, password: 'a-good-password' });
    expect(res.statusCode).toBe(404);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
  });
});

describe('choosing the password', () => {
  it('sets it, spends the link and clears the flag', async () => {
    const res = await call({ action: 'submit', token: TOKEN, password: 'a-good-password' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ email: 'sara@example.com' });

    const [set] = getSupabaseCalls('auth.admin.updateUserById');
    expect(set.payload).toEqual({ id: STUDENT.id, password: 'a-good-password' });

    // Spent, so the same link in a forwarded message opens nothing.
    const [spent] = getSupabaseCalls('password_invites.update');
    expect(spent.payload.used_at).toBeTruthy();

    // And the account stops counting as one that has not been set up.
    const [profile] = getSupabaseCalls('profiles.update');
    expect(profile.payload).toEqual({ must_change_pw: false });
  });

  it('refuses one too short to be a password', async () => {
    for (const password of ['', 'short', undefined, 12345678]) {
      resetSupabaseMock();
      configureSupabaseMock({ results: withInvite() });

      const res = await call({ action: 'submit', token: TOKEN, password });

      expect(res.statusCode, String(password)).toBe(400);
      expect(getSupabaseCalls('auth.admin.updateUserById'), String(password)).toHaveLength(0);
      // Nothing is spent by a failed attempt: the student gets to try
      // again with the link they already have.
      expect(getSupabaseCalls('password_invites.update'), String(password)).toHaveLength(0);
    }
  });

  it('takes the account from the link, never from the request', async () => {
    // The one thing that would make this endpoint a way of setting
    // somebody else's password.
    await call({
      action: 'submit', token: TOKEN, password: 'a-good-password',
      student_id: 'somebody-else', email: 'victim@example.com', teacher_id: 'another-tenant',
    });

    const [set] = getSupabaseCalls('auth.admin.updateUserById');
    expect(set.payload.id).toBe(STUDENT.id);

    const [profile] = getSupabaseCalls('profiles.update');
    expect(profile.filters.id).toBe(STUDENT.id);
  });
});
