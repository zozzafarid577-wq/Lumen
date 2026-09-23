import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  OWNER_USER, TEACHER_USER, ASSISTANT_USER, TEACHER_ID, PROFILES,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/teachers.js';

const PLAN = {
  code: 'full-60', name: 'Platform + Student Support', listing: 'package', package: 'full',
  monthly_fee_egp: 8000, setup_fee_egp: 10000, student_limit: 60,
};

// `teachers` is read for two different questions — "is this slug free?"
// and "which space is this?" — so the resolver answers by which column
// was filtered on. A test that wants the slug taken overrides it.
function baseResults(overrides = {}) {
  return {
    'teachers.select': (call) => call.filters.slug
      ? { data: null, error: null }
      : { data: { id: TEACHER_ID, display_name: 'Advanced Biology', slug: 'advanced-biology' }, error: null },
    'teachers.insert': { data: { id: 'teacher-new', slug: 'advanced-biology' }, error: null },
    'plans.select':    { data: PLAN, error: null },
    ...overrides,
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
  configureSupabaseMock({ results: baseResults() });
});

describe('opening a teacher space', () => {
  it('creates the tenant, the sign-in and the subscription together', async () => {
    const res = await call({
      action: 'create',
      full_name: 'A New Teacher',
      email: 'teacher@example.com',
      display_name: 'Advanced Biology',
      plan_code: 'full-60',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.password).toHaveLength(12);
    expect(res.body.slug).toBe('advanced-biology');

    const [user] = getSupabaseCalls('auth.admin.createUser');
    expect(user.payload.app_metadata).toEqual({ role: 'teacher', teacher_id: 'teacher-new' });

    const [sub] = getSupabaseCalls('subscriptions.insert');
    expect(sub.payload).toMatchObject({
      teacher_id: 'teacher-new', plan_code: 'full-60', status: 'active',
      student_limit: 60, monthly_fee_egp: 8000,
    });

    // The plan's numbers are copied onto the subscription, so re-pricing
    // the catalogue later cannot change what this teacher agreed to.
    const [invoices] = getSupabaseCalls('invoices.insert');
    expect(invoices.payload.map(i => i.kind)).toEqual(['setup', 'monthly']);
    expect(invoices.payload.map(i => i.amount_egp)).toEqual([10000, 8000]);
  });

  it('opens a trial when no plan is chosen', async () => {
    const res = await call({
      action: 'create', full_name: 'A New Teacher', email: 'teacher@example.com', display_name: 'Advanced Biology',
    });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('subscriptions.insert')[0].payload).toMatchObject({ status: 'trial', student_limit: 10 });
    expect(getSupabaseCalls('invoices.insert')).toHaveLength(0);
  });

  it('rolls the whole thing back when the profile insert fails', async () => {
    configureSupabaseMock({ results: { 'profiles.insert': { data: null, error: { message: 'boom' } } } });
    const res = await call({
      action: 'create', full_name: 'A New Teacher', email: 'teacher@example.com', display_name: 'Advanced Biology',
    });

    expect(res.statusCode).toBe(500);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(1);
    // A tenant with no teacher in it is invisible in every portal and
    // still holds its slug, so it has to go too.
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(1);
  });

  it('refuses a slug that is already taken', async () => {
    configureSupabaseMock({ results: { 'teachers.select': { data: { id: 'existing', slug: 'advanced-biology' }, error: null } } });
    const res = await call({
      action: 'create', full_name: 'A New Teacher', email: 'teacher@example.com', display_name: 'Advanced Biology',
    });
    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('teachers.insert')).toHaveLength(0);
  });

  it('refuses a slug the site itself uses', async () => {
    const res = await call({
      action: 'create', full_name: 'A New Teacher', email: 'teacher@example.com', display_name: 'Admin',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
  });
});

describe('editing a space that is already open', () => {
  const SPACE = {
    id: TEACHER_ID, slug: 'advanced-biology', display_name: 'Advanced Biology',
    subject: 'Biology', contact_email: 'teacher@example.com', contact_phone: '0100 000 0000',
  };
  const PERSON = {
    id: 'teacher-uid', teacher_id: TEACHER_ID, role: 'teacher',
    full_name: 'A Teacher', email: 'teacher@example.com', phone: '0100 000 0000',
  };

  // `profiles` is read twice here: authenticate() looks the caller up by
  // id, and the edit finds the one teacher in the space by role.
  function profileResolver(person = PERSON) {
    return (call) => {
      if (call.filters.id) return { data: PROFILES[call.filters.id] || null, error: null };
      if (call.filters.role === 'teacher') return { data: person, error: null };
      return { data: null, error: null };
    };
  }

  beforeEach(() => {
    configureSupabaseMock({ results: {
      'teachers.select': (call) => call.filters.slug ? { data: null, error: null } : { data: SPACE, error: null },
      'profiles.select': profileResolver(),
    } });
  });

  it('moves the sign-in email, the profile and the contact address together', async () => {
    const res = await call({ action: 'update', teacher_id: TEACHER_ID, email: 'new@example.com' });

    expect(res.statusCode).toBe(200);
    // An account that answers to one address while Lumen writes to
    // another is the state this whole branch exists to avoid.
    expect(getSupabaseCalls('auth.admin.updateUserById')[0].payload)
      .toMatchObject({ id: 'teacher-uid', email: 'new@example.com', email_confirm: true });
    expect(getSupabaseCalls('profiles.update')[0].payload).toEqual({ email: 'new@example.com' });
    expect(getSupabaseCalls('teachers.update')[0].payload).toEqual({ contact_email: 'new@example.com' });
  });

  it('refuses an address another account already holds', async () => {
    configureSupabaseMock({ results: {
      'auth.admin.listUsers': { data: { users: [{ id: 'someone-else', email: 'taken@example.com' }] }, error: null },
    } });

    const res = await call({ action: 'update', teacher_id: TEACHER_ID, email: 'taken@example.com' });

    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
  });

  it('lets a teacher keep the address they already have', async () => {
    // Re-submitting the form unchanged must not trip the "already taken"
    // check on the teacher's own account.
    configureSupabaseMock({ results: {
      'auth.admin.listUsers': { data: { users: [{ id: 'teacher-uid', email: 'teacher@example.com' }] }, error: null },
    } });

    const res = await call({
      action: 'update', teacher_id: TEACHER_ID,
      email: 'teacher@example.com', full_name: 'A Teacher', display_name: 'Advanced Biology',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.changed).toEqual([]);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
    expect(getSupabaseCalls('teachers.update')).toHaveLength(0);
    expect(getSupabaseCalls('profiles.update')).toHaveLength(0);
  });

  it('puts the sign-in back when the profile will not follow it', async () => {
    configureSupabaseMock({ results: { 'profiles.update': { data: null, error: { message: 'boom' } } } });

    const res = await call({ action: 'update', teacher_id: TEACHER_ID, email: 'new@example.com' });

    expect(res.statusCode).toBe(500);
    const emails = getSupabaseCalls('auth.admin.updateUserById').map(c => c.payload.email);
    expect(emails).toEqual(['new@example.com', 'teacher@example.com']);
    expect(getSupabaseCalls('teachers.update')).toHaveLength(0);
  });

  it('renames the space and its slug', async () => {
    const res = await call({
      action: 'update', teacher_id: TEACHER_ID, display_name: 'Advanced Chemistry', slug: 'advanced-chemistry',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.slug).toBe('advanced-chemistry');
    expect(getSupabaseCalls('teachers.update')[0].payload)
      .toEqual({ display_name: 'Advanced Chemistry', slug: 'advanced-chemistry' });
  });

  it('refuses a slug another space already holds', async () => {
    configureSupabaseMock({ results: {
      'teachers.select': (c) => c.filters.slug ? { data: { id: 'teacher-2' }, error: null } : { data: SPACE, error: null },
    } });

    const res = await call({ action: 'update', teacher_id: TEACHER_ID, slug: 'someone-else' });

    expect(res.statusCode).toBe(409);
    expect(getSupabaseCalls('teachers.update')).toHaveLength(0);
  });

  it('lets a space keep the slug it already has', async () => {
    // The uniqueness check would otherwise find this very space and
    // refuse to save a form that only changed the subject.
    configureSupabaseMock({ results: {
      'teachers.select': (c) => c.filters.slug ? { data: { id: TEACHER_ID }, error: null } : { data: SPACE, error: null },
    } });

    const res = await call({ action: 'update', teacher_id: TEACHER_ID, slug: 'advanced-biology', subject: 'Chemistry' });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('teachers.update')[0].payload).toEqual({ subject: 'Chemistry' });
  });

  it('refuses a slug the site itself uses', async () => {
    const res = await call({ action: 'update', teacher_id: TEACHER_ID, slug: 'login' });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('teachers.update')).toHaveLength(0);
  });

  it('leaves out what the request did not mention', async () => {
    const res = await call({ action: 'update', teacher_id: TEACHER_ID, subject: 'Chemistry' });

    expect(res.statusCode).toBe(200);
    // A console form that shows six fields must not be able to blank the
    // four columns it does not show.
    expect(getSupabaseCalls('teachers.update')[0].payload).toEqual({ subject: 'Chemistry' });
    expect(getSupabaseCalls('profiles.update')).toHaveLength(0);
  });

  it('puts the phone on both the person and the space', async () => {
    const res = await call({ action: 'update', teacher_id: TEACHER_ID, phone: '0111 111 1111' });

    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('profiles.update')[0].payload).toEqual({ phone: '0111 111 1111' });
    expect(getSupabaseCalls('teachers.update')[0].payload).toEqual({ contact_phone: '0111 111 1111' });
  });

  it('records what changed', async () => {
    await call({ action: 'update', teacher_id: TEACHER_ID, email: 'new@example.com', slug: 'new-slug' });

    const [log] = getSupabaseCalls('activity_log.insert');
    expect(log.payload.event_type).toBe('space_updated');
    expect(log.payload.detail).toMatch(/new@example\.com/);
    expect(log.payload.detail).toMatch(/advanced-biology → new-slug/);
  });

  it('still fixes a space whose teacher account was never created', async () => {
    configureSupabaseMock({ results: { 'profiles.select': profileResolver(null) } });

    const named = await call({ action: 'update', teacher_id: TEACHER_ID, email: 'new@example.com' });
    expect(named.statusCode).toBe(409);

    const renamed = await call({ action: 'update', teacher_id: TEACHER_ID, display_name: 'Advanced Chemistry' });
    expect(renamed.statusCode).toBe(200);
    expect(getSupabaseCalls('teachers.update')[0].payload).toEqual({ display_name: 'Advanced Chemistry' });
  });

  it('turns away a teacher editing their own space', async () => {
    asUser(TEACHER_USER);
    // The sign-in email and the slug are exactly the two things a
    // teacher's own settings page does not let them touch.
    const res = await call({ action: 'update', teacher_id: TEACHER_ID, email: 'new@example.com' });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('auth.admin.updateUserById')).toHaveLength(0);
  });
});

describe('changing a subscription', () => {
  it('copies the plan’s limit and fee onto the subscription', async () => {
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, plan_code: 'full-60' });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('subscriptions.update')[0].payload).toMatchObject({
      plan_code: 'full-60', student_limit: 60, monthly_fee_egp: 8000, status: 'active',
    });
  });

  it('lets a hand-set limit beat the plan’s', async () => {
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, plan_code: 'full-60', student_limit: 75 });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('subscriptions.update')[0].payload.student_limit).toBe(75);
  });

  it('refuses a nonsense limit', async () => {
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, student_limit: 999999 });
    expect(res.statusCode).toBe(400);
  });

  it('records when a subscription was cancelled', async () => {
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, status: 'cancelled' });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('subscriptions.update')[0].payload.cancelled_at).toBeTruthy();
  });

  it('refuses a plan that does not exist', async () => {
    configureSupabaseMock({ results: { 'plans.select': { data: null, error: { message: 'none' } } } });
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, plan_code: 'made-up' });
    expect(res.statusCode).toBe(400);
  });
});

describe('invoices', () => {
  it('raises one', async () => {
    configureSupabaseMock({ results: { 'invoices.insert': { data: { id: 'inv-1' }, error: null } } });
    const res = await call({ action: 'add_invoice', teacher_id: TEACHER_ID, amount_egp: 8000, kind: 'monthly' });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('invoices.insert')[0].payload).toMatchObject({ amount_egp: 8000, kind: 'monthly' });
  });

  it('refuses an amount that is not a positive number', async () => {
    for (const amount of [0, -100, 'free', null]) {
      const res = await call({ action: 'add_invoice', teacher_id: TEACHER_ID, amount_egp: amount });
      expect(res.statusCode, String(amount)).toBe(400);
    }
  });

  it('marks one paid', async () => {
    configureSupabaseMock({
      results: { 'invoices.update': { data: { id: 'inv-1', teacher_id: TEACHER_ID, kind: 'monthly', amount_egp: 8000 }, error: null } },
    });
    const res = await call({ action: 'mark_paid', invoice_id: 'inv-1', reference: 'TRF-9912' });
    expect(res.statusCode).toBe(200);
    expect(getSupabaseCalls('invoices.update')[0].payload).toMatchObject({ status: 'paid', reference: 'TRF-9912' });
  });
});

describe('deleting a space', () => {
  const PEOPLE = [
    { id: 'u1', full_name: 'The Teacher', role: 'teacher' },
    { id: 'u2', full_name: 'An Assistant', role: 'assistant' },
    { id: 'u3', full_name: 'A Student',    role: 'student' },
  ];

  beforeEach(() => {
    configureSupabaseMock({ results: {
      // `profiles` is read three ways here: authenticate() looks the
      // caller up by id, countTenant() counts by role, and the delete
      // lists everyone in the space. One resolver, answering by filter.
      'profiles.select': (call) => {
        if (call.opts?.count) return { data: null, error: null, count: 4 };
        if (call.filters.id) return { data: PROFILES[call.filters.id] || null, error: null };
        return { data: PEOPLE, error: null };
      },
      'courses.select':                { data: null, error: null, count: 2 },
      'practice_tests.select':         { data: null, error: null, count: 7 },
      'test_attempts.select':          { data: null, error: null, count: 91 },
      'assignment_submissions.select': { data: null, error: null, count: 12 },
    } });
  });

  it('shows what will be destroyed before asking to confirm', async () => {
    const res = await call({ action: 'delete_preview', teacher_id: TEACHER_ID });

    expect(res.statusCode).toBe(200);
    expect(res.body.counts).toMatchObject({ courses: 2, tests: 7, attempts: 91 });
    expect(res.body.confirm_with).toBe('advanced-biology');
    // A preview must not touch anything.
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(0);
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(0);
  });

  it('refuses without the slug typed back', async () => {
    const res = await call({ action: 'delete', teacher_id: TEACHER_ID });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/advanced-biology/);
    expect(getSupabaseCalls('auth.admin.deleteUser')).toHaveLength(0);
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(0);
  });

  it('refuses when the slug typed is the wrong one', async () => {
    // The whole safety mechanism. An id is easy to get wrong in a
    // request body; a slug typed by hand is not an accident.
    const res = await call({ action: 'delete', teacher_id: TEACHER_ID, confirm_slug: 'some-other-space' });
    expect(res.statusCode).toBe(400);
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(0);
  });

  it('removes every account, then the space', async () => {
    const res = await call({ action: 'delete', teacher_id: TEACHER_ID, confirm_slug: 'Advanced-Biology' });

    expect(res.statusCode).toBe(200);
    expect(res.body.accounts_removed).toBe(3);

    // Deleting the teachers row cascades the content but never reaches
    // auth.users — left behind, those rows would hold their email
    // addresses forever.
    const removed = getSupabaseCalls('auth.admin.deleteUser').map(c => c.payload.id);
    expect(removed.sort()).toEqual(['u1', 'u2', 'u3']);
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(1);
  });

  it('leaves the space standing when an account will not delete', async () => {
    configureSupabaseMock({ results: {
      'auth.admin.deleteUser': (c) => c.payload.id === 'u2'
        ? { data: null, error: { message: 'still referenced' } }
        : { data: {}, error: null },
    } });

    const res = await call({ action: 'delete', teacher_id: TEACHER_ID, confirm_slug: 'advanced-biology' });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/An Assistant/);
    // Re-running has to be able to finish the job, which it only can if
    // the row is still there.
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(0);
  });

  it('records the deletion outside the space it deleted', async () => {
    await call({ action: 'delete', teacher_id: TEACHER_ID, confirm_slug: 'advanced-biology' });

    const [log] = getSupabaseCalls('activity_log.insert');
    // A log line pointing at the deleted tenant would cascade away with
    // it, and this is the event most worth still having afterwards.
    expect(log.payload.teacher_id).toBeNull();
    expect(log.payload.event_type).toBe('space_deleted');
    expect(log.payload.detail).toMatch(/advanced-biology/);
  });
});

describe('who may call it', () => {
  it('turns away a teacher', async () => {
    asUser(TEACHER_USER);
    const res = await call({ action: 'set_plan', teacher_id: TEACHER_ID, plan_code: 'full-60' });
    // A teacher who could set their own plan could give themselves any
    // student limit they liked.
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('subscriptions.update')).toHaveLength(0);
  });

  it('turns away an assistant', async () => {
    asUser(ASSISTANT_USER);
    const res = await call({ action: 'set_active', teacher_id: TEACHER_ID, is_active: false });
    expect(res.statusCode).toBe(403);
  });

  it('turns a teacher away from deleting a space', async () => {
    asUser(TEACHER_USER);
    const res = await call({ action: 'delete', teacher_id: TEACHER_ID, confirm_slug: 'advanced-biology' });
    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('teachers.delete')).toHaveLength(0);
  });

  it('rejects an unknown action', async () => {
    const res = await call({ action: 'drop_everything' });
    expect(res.statusCode).toBe(400);
  });
});
