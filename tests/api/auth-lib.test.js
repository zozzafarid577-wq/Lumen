import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, configureSupabaseMock, TEACHER_ID, OTHER_TEACHER_ID } from '../helpers/supabase-mock.js';
import { HttpError, requireRoles, requirePerm, tenantFor, assertTenant, handler } from '../../api/_lib/auth.js';
import { makeReq, makeRes } from '../helpers/http.js';

const teacher   = { id: 'a', role: 'teacher',   teacher_id: TEACHER_ID };
const assistant = { id: 'b', role: 'assistant', teacher_id: TEACHER_ID, staff_perms: ['students'] };
const owner     = { id: 'c', role: 'owner',     teacher_id: null };
const student   = { id: 'd', role: 'student',   teacher_id: TEACHER_ID };

beforeEach(resetSupabaseMock);

describe('tenantFor', () => {
  it('confines a teacher to their own space', () => {
    expect(tenantFor(teacher)).toBe(TEACHER_ID);
    expect(tenantFor(teacher, TEACHER_ID)).toBe(TEACHER_ID);
  });

  it('refuses a teacher who names someone else’s space', () => {
    // This is the line that stops a crafted request reaching another
    // teacher's students through a service-role client.
    expect(() => tenantFor(teacher, OTHER_TEACHER_ID)).toThrow(HttpError);
  });

  it('lets Lumen staff name a space, but makes them name one', () => {
    expect(tenantFor(owner, OTHER_TEACHER_ID)).toBe(OTHER_TEACHER_ID);
    expect(() => tenantFor(owner)).toThrow(/teacher_id is required/);
  });

  it('refuses an account attached to no space', () => {
    expect(() => tenantFor({ role: 'teacher', teacher_id: null })).toThrow(HttpError);
  });
});

describe('requirePerm', () => {
  it('gives a teacher every permission on their own space', () => {
    for (const key of ['students', 'courses', 'tests', 'anything-at-all']) {
      expect(() => requirePerm(teacher, key)).not.toThrow();
    }
  });

  it('holds an assistant to the keys they were given', () => {
    expect(() => requirePerm(assistant, 'students')).not.toThrow();
    expect(() => requirePerm(assistant, 'tests')).toThrow(HttpError);
  });

  it('treats a null list as full access', () => {
    // An assistant created before staff_perms existed has null here.
    // Locking them out of their own portal over a missing column would be
    // worse than the permission being wide.
    expect(() => requirePerm({ ...assistant, staff_perms: null }, 'tests')).not.toThrow();
  });

  it('turns away a student whatever the key', () => {
    expect(() => requirePerm(student, 'students')).toThrow(HttpError);
  });
});

describe('requireRoles', () => {
  it('accepts one role or a list', () => {
    expect(() => requireRoles(teacher, 'teacher')).not.toThrow();
    expect(() => requireRoles(assistant, ['teacher', 'assistant'])).not.toThrow();
    expect(() => requireRoles(student, ['teacher', 'assistant'])).toThrow(HttpError);
  });
});

describe('assertTenant', () => {
  it('accepts a row in the caller’s own space', async () => {
    configureSupabaseMock({ results: { 'courses.select': { data: { id: 'c1', teacher_id: TEACHER_ID }, error: null } } });
    await expect(assertTenant('courses', 'c1', TEACHER_ID)).resolves.toMatchObject({ id: 'c1' });
  });

  it('refuses a row in another space', async () => {
    configureSupabaseMock({ results: { 'courses.select': { data: { id: 'c1', teacher_id: OTHER_TEACHER_ID }, error: null } } });
    await expect(assertTenant('courses', 'c1', TEACHER_ID)).rejects.toThrow(/another teacher/);
  });

  it('refuses a row that is not there', async () => {
    configureSupabaseMock({ results: { 'courses.select': { data: null, error: { message: 'none' } } } });
    await expect(assertTenant('courses', 'c1', TEACHER_ID)).rejects.toThrow(/no longer exists/);
  });
});

describe('handler', () => {
  it('turns an HttpError into its status', async () => {
    const res = makeRes();
    await handler(async () => { throw new HttpError(418, 'no'); })(makeReq({}), res);
    expect(res.statusCode).toBe(418);
    expect(res.body).toEqual({ error: 'no' });
  });

  it('never leaks an unexpected error to the caller', async () => {
    const res = makeRes();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler(async () => { throw new Error('connection string is postgres://user:hunter2@host'); })(makeReq({}), res);
    quiet.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(res.body.error).not.toMatch(/hunter2/);
  });

  it('rejects the wrong method and says which are allowed', async () => {
    const res = makeRes();
    await handler(async () => {}, { methods: ['POST'] })(makeReq({ method: 'DELETE' }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
  });
});
