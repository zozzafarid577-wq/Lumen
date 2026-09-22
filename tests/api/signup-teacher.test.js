import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, configureSupabaseMock, getSupabaseCalls } from '../helpers/supabase-mock.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/signup-teacher.js';

const GOOD = {
  full_name: 'A New Teacher',
  email: 'teacher@example.com',
  password: 'a-good-password',
  display_name: 'Advanced Biology',
  subject: 'Biology',
};

async function call(body) {
  const res = makeRes();
  // No Authorization header: this is the one public endpoint.
  await handler(makeReq({ body, token: null }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  configureSupabaseMock({
    results: {
      'teachers.select': { data: null, error: null },       // slug is free
      'teachers.insert': { data: { id: 'teacher-new', slug: 'advanced-biology' }, error: null },
    },
  });
});

describe('a teacher starting their own trial', () => {
  it('creates the space, the account and the trial', async () => {
    const res = await call(GOOD);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ teacher_id: 'teacher-new', slug: 'advanced-biology', student_limit: 10 });

    const [user] = getSupabaseCalls('auth.admin.createUser');
    expect(user.payload.app_metadata).toEqual({ role: 'teacher', teacher_id: 'teacher-new' });

    // They chose this password themselves, so there is nobody else who
    // knows it and nothing to force them to change.
    expect(getSupabaseCalls('profiles.insert')[0].payload.must_change_pw).toBe(false);
    expect(getSupabaseCalls('subscriptions.insert')[0].payload.status).toBe('trial');
  });

  it('never creates anything but a brand-new tenant', async () => {
    await call(GOOD);
    // The only writes this endpoint makes are inserts into rows it just
    // created — nothing existing is read for update or deleted.
    const writes = getSupabaseCalls().filter(c => ['update', 'delete', 'upsert'].includes(c.op));
    expect(writes).toEqual([]);
  });

  it('refuses a short password', async () => {
    const res = await call({ ...GOOD, password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('teachers.insert')).toHaveLength(0);
  });

  it('refuses an email that is not one', async () => {
    const res = await call({ ...GOOD, email: 'nope' });
    expect(res.statusCode).toBe(400);
  });

  it('says plainly when the address already has an account', async () => {
    configureSupabaseMock({
      results: { 'auth.admin.listUsers': { data: { users: [{ email: 'teacher@example.com' }] }, error: null } },
    });
    const res = await call(GOOD);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/signing in/i);
  });

  it('refuses a space name that is already taken', async () => {
    configureSupabaseMock({ results: { 'teachers.select': { data: { id: 'existing' }, error: null } } });
    const res = await call(GOOD);
    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('teachers.insert')).toHaveLength(0);
  });

  it('leaves nothing behind when the account cannot be made', async () => {
    configureSupabaseMock({
      results: { 'auth.admin.createUser': { data: null, error: { message: 'rejected' } } },
    });
    const res = await call(GOOD);

    expect(res.statusCode).toBe(400);
    // A half-made space would hold its slug forever and stop them from
    // simply trying again.
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(1);
  });

  it('rejects anything but POST', async () => {
    const res = makeRes();
    await handler(makeReq({ body: GOOD, token: null, method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });
});
