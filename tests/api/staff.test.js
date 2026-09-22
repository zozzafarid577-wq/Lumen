import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  TEACHER_USER, ASSISTANT_USER, OWNER_USER, TEACHER_ID, OTHER_TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/staff.js';

const MINE   = { id: 'asst-1', full_name: 'Nour Hassan', email: 'nour@example.com', role: 'assistant', teacher_id: TEACHER_ID };
const THEIRS = { ...MINE, id: 'asst-2', teacher_id: OTHER_TEACHER_ID };

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(TEACHER_USER, { extraProfiles: { 'asst-1': MINE, 'asst-2': THEIRS } });
});

describe('adding an assistant', () => {
  it('creates them inside the teacher’s own tenant', async () => {
    const res = await call({
      action: 'create', full_name: 'Nour Hassan', email: 'nour@example.com',
      staff_perms: ['students', 'tests'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.password).toHaveLength(12);

    const [user] = getSupabaseCalls('auth.admin.createUser');
    expect(user.payload.app_metadata).toEqual({ role: 'assistant', teacher_id: TEACHER_ID });

    const [profile] = getSupabaseCalls('profiles.insert');
    expect(profile.payload).toMatchObject({
      role: 'assistant', teacher_id: TEACHER_ID, staff_perms: ['students', 'tests'], must_change_pw: true,
    });
  });

  it('drops permissions that are not real ones', async () => {
    const res = await call({
      action: 'create', full_name: 'Nour Hassan', email: 'nour@example.com',
      staff_perms: ['students', 'everything', 'billing'],
    });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('profiles.insert')[0].payload.staff_perms).toEqual(['students']);
  });

  it('refuses an assistant with no permissions at all', async () => {
    const res = await call({
      action: 'create', full_name: 'Nour Hassan', email: 'nour@example.com', staff_perms: ['made-up'],
    });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('deletes the auth user again when the profile fails', async () => {
    configureSupabaseMock({ results: { 'profiles.insert': { data: null, error: { message: 'boom' } } } });
    const res = await call({
      action: 'create', full_name: 'Nour Hassan', email: 'nour@example.com', staff_perms: ['students'],
    });
    expect(res.statusCode).toBe(500);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(1);
  });
});

describe('managing an assistant', () => {
  it('changes their permissions', async () => {
    const res = await call({ action: 'set_perms', staff_id: 'asst-1', staff_perms: ['courses'] });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('profiles.update')[0].payload).toEqual({ staff_perms: ['courses'] });
  });

  it('will not leave them with none', async () => {
    const res = await call({ action: 'set_perms', staff_id: 'asst-1', staff_perms: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Remove them instead/);
  });

  it('will not touch an assistant in another tenant', async () => {
    for (const action of ['set_perms', 'set_active', 'remove']) {
      resetSupabaseMock();
      asUser(TEACHER_USER, { extraProfiles: { 'asst-2': THEIRS } });
      const res = await call({ action, staff_id: 'asst-2', staff_perms: ['students'] });
      expect(res.statusCode, action).toBe(403);
    }
  });

  it('will not act on an account that is not an assistant', async () => {
    // Otherwise a teacher could delete themselves through this endpoint.
    const res = await call({ action: 'remove', staff_id: 'teacher-uid' });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(0);
  });
});

describe('who may call it', () => {
  it('turns away an assistant', async () => {
    // An assistant who could add assistants could grant themselves every
    // permission their teacher withheld.
    asUser(ASSISTANT_USER);
    const res = await call({
      action: 'create', full_name: 'Someone Else', email: 'x@example.com', staff_perms: ['students'],
    });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
  });

  it('makes Lumen staff name the tenant', async () => {
    asUser(OWNER_USER);
    const res = await call({
      action: 'create', full_name: 'Someone Else', email: 'x@example.com', staff_perms: ['students'],
    });
    expect(res.statusCode).toBe(400);
  });
});
