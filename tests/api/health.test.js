import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, TEACHER_USER } from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import health from '../../api/health.js';
import students from '../../api/students.js';

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('/api/health', () => {
  it('reports every variable as set when it is', async () => {
    const res = makeRes();
    await health(makeReq({ method: 'GET' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.missing).toEqual([]);
    expect(res.body.env.SUPABASE_URL).toBe(true);
  });

  it('names what is missing and answers 503', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = makeRes();
    await health(makeReq({ method: 'GET' }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
    expect(res.body.hint).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('never echoes a secret back', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'super-secret-service-role-key';
    process.env.BREVO_API_KEY = 'xkeysib-secret';
    const res = makeRes();
    await health(makeReq({ method: 'GET' }), res);

    // A public endpoint reporting configuration must report only whether
    // each value is set, never the value.
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain('super-secret-service-role-key');
    expect(dump).not.toContain('xkeysib-secret');
    expect(res.body.env.SUPABASE_SERVICE_ROLE_KEY).toBe(true);
  });
});

describe('an endpoint on an unconfigured deployment', () => {
  beforeEach(() => { resetSupabaseMock(); asUser(TEACHER_USER); });

  it('says which variable is missing instead of crashing', async () => {
    // The clients are built on first use precisely so this lands inside
    // handler() and comes back as a sentence, rather than killing the
    // function at import and leaving the platform to answer with its own
    // FUNCTION_INVOCATION_FAILED.
    delete process.env.SUPABASE_URL;

    const res = makeRes();
    await students(makeReq({ body: { action: 'create' } }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/SUPABASE_URL/);
    expect(res.body.error).toMatch(/not configured/i);
  });
});
