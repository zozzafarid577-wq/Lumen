import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  OWNER_USER, TEACHER_USER, STUDENT_USER,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/plans.js';

const TIER = {
  code: 'tier-60', name: 'Up to 60 students', listing: 'tier', package: 'full',
  monthly_fee_egp: 6000, setup_fee_egp: 10000, student_limit: 60,
  blurb: null, features: [], sort_order: 110, is_active: true,
};

// A plan that already exists, and the teachers who hold it.
function world({ plan = TIER, holders = [] } = {}) {
  configureSupabaseMock({ results: {
    'plans.select': { data: plan, error: null },
    'subscriptions.select': { data: holders, error: null },
  } });
}

const FULL = {
  code: 'tier-60', name: 'Up to 60 students', listing: 'tier', package: 'full',
  monthly_fee_egp: 6000, setup_fee_egp: 10000, student_limit: 60,
};

async function call(body, req = {}) {
  const res = makeRes();
  await handler(makeReq({ body, ...req }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(OWNER_USER);
});

describe('saving a plan', () => {
  it('creates one that does not exist yet', async () => {
    world({ plan: null });
    const res = await call({ ...FULL, code: 'tier-200', name: 'Up to 200 students', student_limit: 200, monthly_fee_egp: 12000 });

    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(true);

    const [insert] = getSupabaseCalls('plans.insert');
    expect(insert.payload).toMatchObject({
      code: 'tier-200', monthly_fee_egp: 12000, student_limit: 200, is_active: true,
    });
    expect(getSupabaseCalls('plans.update')).toHaveLength(0);
  });

  it('updates one that does, by its code', async () => {
    world();
    const res = await call({ ...FULL, monthly_fee_egp: 7000 });

    expect(res.body.created).toBe(false);
    const [update] = getSupabaseCalls('plans.update');
    expect(update.filters.code).toBe('tier-60');
    expect(update.payload.monthly_fee_egp).toBe(7000);
    expect(getSupabaseCalls('plans.insert')).toHaveLength(0);
  });

  it('leaves the teachers already on it at the price they agreed', async () => {
    // The whole point of a subscription carrying its own numbers: a list
    // price moving must not move somebody's bill behind their back.
    world({ holders: [{ teacher_id: 't1' }, { teacher_id: 't2' }] });
    const res = await call({ ...FULL, monthly_fee_egp: 7000 });

    expect(getSupabaseCalls('subscriptions.update')).toHaveLength(0);
    expect(res.body.holders).toBe(2);
    expect(res.body.left_on_old_price).toBe(2);
    expect(res.body.applied).toBe(0);
  });

  it('moves them only when that is asked for outright', async () => {
    world({ holders: [{ teacher_id: 't1' }, { teacher_id: 't2' }] });
    const res = await call({ ...FULL, monthly_fee_egp: 7000, apply_to_subscriptions: true });

    const [update] = getSupabaseCalls('subscriptions.update');
    expect(update.filters.plan_code).toBe('tier-60');
    expect(update.payload).toEqual({ monthly_fee_egp: 7000, setup_fee_egp: 10000, student_limit: 60 });
    expect(res.body.applied).toBe(2);
    expect(res.body.left_on_old_price).toBe(0);
  });

  it('does not call it a reprice when only the wording changed', async () => {
    world({ holders: [{ teacher_id: 't1' }] });
    const res = await call({ ...FULL, name: 'Up to 60 pupils', blurb: 'Our most popular.' });

    expect(res.body.left_on_old_price).toBe(0);
  });

  it('tidies the code rather than trusting what was typed', async () => {
    world({ plan: null });
    await call({ ...FULL, code: '  Tier 250!! ' });

    const [insert] = getSupabaseCalls('plans.insert');
    expect(insert.payload.code).toBe('tier-250');
  });

  it('takes features as lines of text and drops the empty ones', async () => {
    world({ plan: null });
    await call({ ...FULL, code: 'basic-60', features: 'Dashboard\n\n  Reports  \n' });

    const [insert] = getSupabaseCalls('plans.insert');
    expect(insert.payload.features).toEqual(['Dashboard', 'Reports']);
  });

  it('refuses prices and limits that are not sensible', async () => {
    world();
    for (const body of [
      { ...FULL, monthly_fee_egp: -1 },
      { ...FULL, monthly_fee_egp: 5999.5 },
      { ...FULL, setup_fee_egp: 'free' },
      { ...FULL, student_limit: 0 },
      { ...FULL, student_limit: 999999 },
      { ...FULL, listing: 'banner' },
      { ...FULL, package: 'deluxe' },
      { ...FULL, code: 'x' },
    ]) {
      resetSupabaseMock();
      asUser(OWNER_USER);
      world();
      const res = await call(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(getSupabaseCalls('plans.update')).toHaveLength(0);
      expect(getSupabaseCalls('plans.insert')).toHaveLength(0);
    }
  });
});

describe('retiring a plan', () => {
  it('turns it off without touching anybody on it', async () => {
    world({ holders: [{ teacher_id: 't1' }] });
    const res = await call({ action: 'set_active', code: 'tier-60', is_active: false });

    expect(res.statusCode).toBe(200);
    const [update] = getSupabaseCalls('plans.update');
    expect(update.payload).toEqual({ is_active: false });
    expect(getSupabaseCalls('subscriptions.update')).toHaveLength(0);
  });

  it('will not delete a plan teachers are on', async () => {
    world({ holders: [{ teacher_id: 't1' }] });
    const res = await call({ action: 'delete', code: 'tier-60' });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/turn it off instead/i);
    expect(getSupabaseCalls('plans.delete')).toHaveLength(0);
  });

  it('deletes one nobody is on', async () => {
    world({ holders: [] });
    const res = await call({ action: 'delete', code: 'tier-60' });

    expect(res.statusCode).toBe(200);
    const [del] = getSupabaseCalls('plans.delete');
    expect(del.filters.code).toBe('tier-60');
  });

  it('says so when the plan is not there at all', async () => {
    world({ plan: null });
    const res = await call({ action: 'delete', code: 'tier-60' });
    expect(res.statusCode).toBe(404);
  });
});

describe('the order they are listed in', () => {
  it('numbers them in tens so one can be slipped between later', async () => {
    const res = await call({ action: 'reorder', codes: ['full-60', 'basic-60', 'tier-60'] });

    expect(res.statusCode).toBe(200);
    const updates = getSupabaseCalls('plans.update');
    expect(updates.map(u => [u.filters.code, u.payload.sort_order]))
      .toEqual([['full-60', 10], ['basic-60', 20], ['tier-60', 30]]);
  });

  it('needs an order to have been given', async () => {
    const res = await call({ action: 'reorder', codes: [] });
    expect(res.statusCode).toBe(400);
  });
});

describe('who may change prices', () => {
  it('turns away a teacher', async () => {
    asUser(TEACHER_USER);
    world();
    const res = await call({ ...FULL, monthly_fee_egp: 1 });

    expect(res.statusCode).toBe(403);
    expect(getSupabaseCalls('plans.update')).toHaveLength(0);
  });

  it('turns away a student', async () => {
    asUser(STUDENT_USER);
    world();
    const res = await call({ ...FULL, monthly_fee_egp: 1 });
    expect(res.statusCode).toBe(403);
  });

  it('turns away a request with no token', async () => {
    const res = await call({ ...FULL }, { token: null });
    expect(res.statusCode).toBe(401);
  });

  it('turns away an unknown action', async () => {
    const res = await call({ action: 'drop_everything' });
    expect(res.statusCode).toBe(400);
  });
});
