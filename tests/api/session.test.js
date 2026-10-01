import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, STUDENT_USER, TEACHER_USER } from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/join.js';

// The server's copy of a sign-in, for the day Safari wipes the browser's.
// What matters: it is only kept for a real signed-in caller, it is handed
// back only to the browser holding the cookie, a dead one is thrown away
// rather than tried for ever, and signing out removes it.

const LUMEN = { 'x-lumen': '1' };
const cookies = res => [].concat(res.headers['Set-Cookie'] || []);
const named = (res, name) => cookies(res).find(c => c.startsWith(name + '='));

function authServer(reply) {
  const fetchMock = vi.fn(async () => reply);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { resetSupabaseMock(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('/api/join session keep', () => {
  it('keeps the refresh token in a cookie no page script can read, and the role beside it', async () => {
    asUser(STUDENT_USER);
    const res = makeRes();
    await handler(makeReq({ headers: LUMEN, body: { flow: 'session', action: 'keep', refresh_token: 'rt-1' } }), res);

    expect(res.statusCode).toBe(200);
    const rt = named(res, 'lumen_rt');
    expect(rt).toMatch(/^lumen_rt=rt-1;/);
    expect(rt).toMatch(/HttpOnly/);
    expect(rt).toMatch(/Secure/);
    expect(rt).toMatch(/Path=\/api\/join/);
    expect(rt).toMatch(/Max-Age=34560000/);
    const mark = named(res, 'lumen_in');
    expect(mark).toMatch(/^lumen_in=student;/);
    expect(mark).not.toMatch(/HttpOnly/);
  });

  it('records a teacher as a teacher', async () => {
    asUser(TEACHER_USER);
    const res = makeRes();
    await handler(makeReq({ headers: LUMEN, body: { flow: 'session', action: 'keep', refresh_token: 'rt-1' } }), res);
    expect(named(res, 'lumen_in')).toMatch(/^lumen_in=teacher;/);
  });

  it('keeps nothing for a caller who is not signed in', async () => {
    const res = makeRes();
    await handler(makeReq({ token: null, headers: LUMEN, body: { flow: 'session', action: 'keep', refresh_token: 'rt-1' } }), res);
    expect(res.statusCode).toBe(401);
    expect(cookies(res)).toEqual([]);
  });

  it('refuses a request that did not come from a Lumen page', async () => {
    asUser(STUDENT_USER);
    const res = makeRes();
    await handler(makeReq({ body: { flow: 'session', action: 'keep', refresh_token: 'rt-1' } }), res);
    expect(res.statusCode).toBe(400);
    expect(cookies(res)).toEqual([]);
  });
});

describe('/api/join session restore', () => {
  it('says there is nothing to restore when no copy was kept', async () => {
    const fetchMock = authServer({ ok: true, json: async () => ({}) });
    const res = makeRes();
    await handler(makeReq({ token: null, headers: LUMEN, body: { flow: 'session', action: 'restore' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ restored: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trades the kept token for a fresh session, and keeps the rotated one', async () => {
    const fetchMock = authServer({ ok: true, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2' }) });
    const res = makeRes();
    await handler(makeReq({
      token: null, headers: { ...LUMEN, cookie: 'other=1; lumen_rt=rt-1; lumen_in=student' },
      body: { flow: 'session', action: 'restore' },
    }), res);

    expect(res.body).toEqual({ restored: true, access_token: 'at-2', refresh_token: 'rt-2' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/v1\/token\?grant_type=refresh_token$/);
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'rt-1' });
    expect(named(res, 'lumen_rt')).toMatch(/^lumen_rt=rt-2;/);
  });

  it('throws away a token the auth server will not take, so nobody is sent round again', async () => {
    authServer({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
    const res = makeRes();
    await handler(makeReq({
      token: null, headers: { ...LUMEN, cookie: 'lumen_rt=revoked' }, body: { flow: 'session', action: 'restore' },
    }), res);

    expect(res.body).toEqual({ restored: false });
    expect(named(res, 'lumen_rt')).toMatch(/Max-Age=0/);
    expect(named(res, 'lumen_in')).toMatch(/Max-Age=0/);
  });
});

describe('/api/join session forget', () => {
  it('clears both cookies', async () => {
    const res = makeRes();
    await handler(makeReq({ token: null, headers: LUMEN, body: { flow: 'session', action: 'forget' } }), res);

    expect(res.statusCode).toBe(200);
    expect(named(res, 'lumen_rt')).toMatch(/^lumen_rt=;.*Max-Age=0/);
    expect(named(res, 'lumen_in')).toMatch(/^lumen_in=;.*Max-Age=0/);
  });
});
