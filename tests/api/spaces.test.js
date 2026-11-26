import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls, OWNER_USER, TEACHER_ID, PROFILES,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/teachers.js';
import { switchSpace } from '../../api/_lib/spaces.js';

const MAIN = { id: TEACHER_ID, group_id: null, slug: 'dr-mai-bio', display_name: 'Dr Mai Biology', is_active: true,
  contact_email: 'mai@example.com', brand_color: '#123456' };
const CHEM = { id: 'space-chem', group_id: TEACHER_ID, slug: 'dr-mai-chem', display_name: 'Dr Mai Chemistry', is_active: true };

// `teachers` answers by what was asked: one space by id, the subjects by
// group_id, and "is this slug free?" by slug.
function spaces(list = [MAIN, CHEM]) {
  return (call) => {
    if (call.filters.slug) return { data: null, error: null };
    if (call.filters.group_id) return { data: list.filter(x => x.group_id === call.filters.group_id), error: null };
    if (call.filters.id) return { data: list.find(x => x.id === call.filters.id) || null, error: null };
    return { data: null, error: null };
  };
}

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(OWNER_USER);
});

describe('another subject for a teacher', () => {
  it('opens a space under the main one with no new sign-in and no plan of its own', async () => {
    configureSupabaseMock({ results: {
      'teachers.select': spaces([MAIN]),
      'teachers.insert': { data: { id: 'space-new', slug: 'dr-mai-physics' }, error: null },
    } });
    const res = await call({ action: 'create', group_with: TEACHER_ID, display_name: 'Dr Mai Physics', subject: 'Physics' });

    expect(res.statusCode).toBe(200);
    expect(res.body.subject_of).toBe('Dr Mai Biology');
    expect(getSupabaseCalls('teachers.insert')[0].payload).toMatchObject({ group_id: TEACHER_ID, contact_email: 'mai@example.com' });
    expect(getSupabaseCalls('auth.admin.createUser')).toHaveLength(0);
    expect(getSupabaseCalls('subscriptions.insert')).toHaveLength(0);
  });

  it('files a subject of a subject under the main space', async () => {
    configureSupabaseMock({ results: {
      'teachers.select': spaces(),
      'teachers.insert': { data: { id: 'space-new', slug: 'x' }, error: null },
    } });
    await call({ action: 'create', group_with: 'space-chem', display_name: 'Dr Mai Physics' });
    expect(getSupabaseCalls('teachers.insert')[0].payload.group_id).toBe(TEACHER_ID);
  });

  it('keeps the plan on the main space', async () => {
    configureSupabaseMock({ results: { 'teachers.select': spaces() } });
    const res = await call({ action: 'set_plan', teacher_id: 'space-chem', status: 'active' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/main space/);
  });

  it('will not delete a main space that still has subjects', async () => {
    configureSupabaseMock({ results: { 'teachers.select': spaces() } });
    const res = await call({ action: 'delete', teacher_id: TEACHER_ID, confirm_slug: 'dr-mai-bio' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Dr Mai Chemistry/);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(0);
  });

  it('a custom fee overrides the plan’s, for Lumen’s records', async () => {
    configureSupabaseMock({ results: { 'teachers.select': spaces() } });
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, status: 'active', monthly_fee_egp: 4500 });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('subscriptions.update')[0].payload.monthly_fee_egp).toBe(4500);
  });
});

describe('switching subject', () => {
  const teacher = { id: 'teacher-uid', role: 'teacher', teacher_id: TEACHER_ID };

  it('moves the sign-in and the profile to another subject of the same teacher', async () => {
    configureSupabaseMock({ results: { 'teachers.select': spaces() } });
    const out = await switchSpace(teacher, 'space-chem');
    expect(out.teacher_id).toBe('space-chem');
    expect(getSupabaseCalls('auth.admin.updateUserById')[0].payload.app_metadata).toEqual({ role: 'teacher', teacher_id: 'space-chem' });
    expect(getSupabaseCalls('profiles.update')[0].payload).toEqual({ teacher_id: 'space-chem' });
  });

  it('refuses a space that belongs to someone else', async () => {
    configureSupabaseMock({ results: { 'teachers.select': spaces() } });
    await expect(switchSpace(teacher, 'someone-else')).rejects.toThrow(/not one of yours/);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
  });

  it('is only for the teacher, not their assistants', async () => {
    await expect(switchSpace({ ...teacher, role: 'assistant' }, 'space-chem')).rejects.toThrow(/Only the teacher/);
  });
});

describe('moving a space that already exists under a main space', () => {
  const PSY = { id: 'space-psy', group_id: null, slug: 'ap-psychology', display_name: 'AP Psychology', is_active: true, contact_email: 'p@example.com' };
  const SUB = { id: 'sub-psy', teacher_id: 'space-psy', plan_code: 'tier-150', status: 'active', student_limit: 150, monthly_fee_egp: 12000, setup_fee_egp: 10000, created_at: 'x' };
  // profiles: the group's logins (by in:teacher_id) and this space's own.
  const people = (groupLogins, own) => (call) => call.filters.id ? { data: PROFILES[call.filters.id], error: null } : call.filters['in:teacher_id'] ? { data: groupLogins, error: null } : { data: own, error: null };

  it('files it under an existing main and switches off its own sign-in', async () => {
    configureSupabaseMock({ results: {
      'teachers.select': spaces([MAIN, PSY]),
      'profiles.select': people([{ id: 'mai' }], [{ id: 'psy-login', full_name: 'Dr Mai', email: 'p@example.com' }]),
    } });
    const res = await call({ action: 'move_under', teacher_id: 'space-psy', group_with: TEACHER_ID });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ main_id: TEACHER_ID, switched_off: ['p@example.com'] });
    expect(getSupabaseCalls('teachers.update')[0].payload).toEqual({ group_id: TEACHER_ID });
    expect(getSupabaseCalls('auth.admin.updateUserById')[0].payload).toMatchObject({ id: 'psy-login', ban_duration: '876000h' });
    expect(getSupabaseCalls('profiles.update')[0].payload).toEqual({ is_active: false });
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(0);
  });

  it('makes a new empty main space that takes over the plan', async () => {
    configureSupabaseMock({ results: {
      'teachers.select': spaces([PSY]),
      'teachers.insert': { data: { id: 'main-new', display_name: 'Dr. Mai Abd El Salam' }, error: null },
      'subscriptions.select': { data: SUB, error: null },
      'profiles.select': people([], [{ id: 'psy-login', email: 'p@example.com' }]),
    } });
    const res = await call({ action: 'move_under', teacher_id: 'space-psy', new_main: { display_name: 'Dr. Mai Abd El Salam' }, keep_login: true });

    expect(res.statusCode).toBe(200);
    expect(res.body.main_id).toBe('main-new');
    expect(getSupabaseCalls('subscriptions.insert')[0].payload).toMatchObject({ teacher_id: 'main-new', plan_code: 'tier-150', student_limit: 150 });
    expect(getSupabaseCalls('subscriptions.insert')[0].payload.id).toBeUndefined();
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
  });

  it('refuses a second sign-in for a group that has one', async () => {
    configureSupabaseMock({ results: {
      'teachers.select': spaces([MAIN, PSY]),
      'profiles.select': people([{ id: 'mai' }], [{ id: 'psy-login' }]),
    } });
    const res = await call({ action: 'move_under', teacher_id: 'space-psy', group_with: TEACHER_ID, keep_login: true });
    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('teachers.update')).toHaveLength(0);
  });

  it('refuses a space that is already a subject', async () => {
    configureSupabaseMock({ results: { 'teachers.select': spaces() } });
    const res = await call({ action: 'move_under', teacher_id: 'space-chem', group_with: TEACHER_ID });
    expect(res.statusCode).toBe(400);
  });
});
