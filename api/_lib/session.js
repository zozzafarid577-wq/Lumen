import { authenticate, HttpError } from './auth.js';

// A second copy of the sign-in, kept by the server.
//
// supabase-js keeps the session in localStorage, and Safari deletes
// everything a site has written there once nobody has opened the site for
// seven days. A student who opens Lumen once a week, for their lesson, is
// past that every single time — signed out, asked for the password again.
// Cookies set by the server in its own response are not under that rule,
// so the refresh token is also kept here, out of reach of page scripts,
// and handed back when the browser's own copy has gone.
//
//   keep     — signed in: remember this refresh token (and the role)
//   restore  — no session in the browser: trade the kept token for a
//              fresh session, or say there is none
//   forget   — signed out: drop both cookies
//
// The token rotates every time it is used, so the browser calls `keep`
// again after each refresh; an old one stops working within seconds.
//
// Reached as POST /api/join with { flow: 'session' }: Vercel's plan allows
// twelve functions and api/ already has twelve (see api/join.js).

const RT = 'lumen_rt';
const MARK = 'lumen_in';
const MAX_AGE = 400 * 24 * 60 * 60;   // the longest any browser honours
const ROLES = new Set(['student', 'teacher', 'assistant', 'owner']);

export async function runSession(req, res) {
  // A page of ours sends this; a form on someone else's site cannot.
  if (req.headers?.['x-lumen'] !== '1') throw new HttpError(400, 'Bad request.');

  const action = req.body?.action;

  if (action === 'keep') {
    const { profile } = await authenticate(req);
    const token = String(req.body?.refresh_token || '').trim();
    if (!token || token.length > 512) throw new HttpError(400, 'No session to keep.');
    setCookies(res, [
      cookie(RT, token, { httpOnly: true, path: '/api/join' }),
      // Not secret: only says a sign-in is kept and where its owner
      // belongs, so the front page can send them on before any script
      // has loaded.
      cookie(MARK, ROLES.has(profile.role) ? profile.role : 'student', { httpOnly: false, path: '/' }),
    ]);
    return res.status(200).json({ kept: true });
  }

  if (action === 'restore') {
    const token = readCookie(req, RT);
    if (!token) return res.status(200).json({ restored: false });

    const session = await refresh(token);
    if (!session) {
      // Signed out elsewhere, expired, or already used: it will never
      // work again, so stop sending people on with it.
      forget(res);
      return res.status(200).json({ restored: false });
    }
    setCookies(res, [cookie(RT, session.refresh_token, { httpOnly: true, path: '/api/join' })]);
    return res.status(200).json({
      restored: true,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  if (action === 'forget') {
    forget(res);
    return res.status(200).json({ forgotten: true });
  }

  throw new HttpError(400, 'Unknown action.');
}

// Straight to the auth server rather than through a shared client, so no
// session state can leak from one request into the next.
async function refresh(token) {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) throw new HttpError(503, 'Lumen is not configured: SUPABASE_URL or SUPABASE_ANON_KEY is not set on this deployment.');
  try {
    const resp = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.access_token && data?.refresh_token ? data : null;
  } catch (_) {
    // The auth server unreachable is not the same as the token being bad,
    // but either way there is nothing to hand back right now.
    return null;
  }
}

function forget(res) {
  setCookies(res, [
    cookie(RT, '', { httpOnly: true, path: '/api/join', maxAge: 0 }),
    cookie(MARK, '', { httpOnly: false, path: '/', maxAge: 0 }),
  ]);
}

function cookie(name, value, { httpOnly, path, maxAge = MAX_AGE }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'Secure',
    'SameSite=Lax',
    httpOnly ? 'HttpOnly' : null,
  ].filter(Boolean).join('; ');
}

function setCookies(res, list) {
  res.setHeader('Set-Cookie', list);
  res.setHeader('Cache-Control', 'no-store');
}

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return ''; }
    }
  }
  return '';
}
