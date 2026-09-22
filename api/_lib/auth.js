import { admin, anon } from './supabase.js';

// A failure with a status code, so handlers can `throw` instead of
// threading `return res.status(...)` through every branch.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Who is calling. Returns the auth user and their profile row.
//
// The role comes from the profile in the database, not from the token's
// app_metadata: the two are written together, but the profile is the one
// an admin can revoke immediately, and a token minted before a demotion
// stays valid for the rest of its hour.
export async function authenticate(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Not signed in.');

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');

  const { data: profile, error: pErr } = await admin
    .from('profiles').select('*').eq('id', data.user.id).single();
  if (pErr || !profile) throw new HttpError(403, 'No Lumen profile is attached to this account.');
  if (!profile.is_active) throw new HttpError(403, 'This account has been deactivated.');

  profile.email = data.user.email || profile.email || null;
  return { user: data.user, profile };
}

export function requireRoles(profile, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(profile.role)) throw new HttpError(403, 'You do not have access to do that.');
  return profile;
}

// An assistant only has the keys their teacher granted. A teacher always
// has every key on their own space; Lumen staff are not assistants and
// never reach this.
export function requirePerm(profile, key) {
  if (profile.role === 'teacher' || profile.role === 'owner') return profile;
  if (profile.role !== 'assistant') throw new HttpError(403, 'You do not have access to do that.');
  const perms = profile.staff_perms;
  if (perms == null) return profile;   // granted before staff_perms existed
  if (!Array.isArray(perms) || !perms.includes(key)) {
    throw new HttpError(403, 'Your teacher has not given you access to this.');
  }
  return profile;
}

// The tenant a staff caller is acting on. Lumen staff may name one
// explicitly; everyone else is confined to their own, whatever the
// request body asked for.
//
// This is the single line that keeps a service-role handler from reaching
// into another teacher's data, so every handler that writes tenant-owned
// rows must get its teacher_id from here and from nowhere else.
export function tenantFor(profile, requestedTeacherId) {
  if (profile.role === 'owner') {
    if (!requestedTeacherId) throw new HttpError(400, 'teacher_id is required.');
    return requestedTeacherId;
  }
  if (!profile.teacher_id) throw new HttpError(403, 'This account is not attached to a teacher.');
  if (requestedTeacherId && requestedTeacherId !== profile.teacher_id) {
    throw new HttpError(403, 'You cannot act on another teacher’s space.');
  }
  return profile.teacher_id;
}

// Confirm a row the caller named really belongs to their tenant, before
// updating or deleting it. Without this an id from another tenant, pasted
// into a request, would be acted on by a client that ignores RLS.
export async function assertTenant(table, id, teacherId) {
  const { data, error } = await admin.from(table).select('id, teacher_id').eq('id', id).single();
  if (error || !data) throw new HttpError(404, 'That record no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That record belongs to another teacher.');
  return data;
}

// Record what staff did, for the teacher (and Lumen) to review later.
export async function logActivity(teacherId, actor, eventType, detail) {
  try {
    await admin.from('activity_log').insert({
      teacher_id: teacherId,
      actor_id: actor?.id || null,
      actor_name: actor?.full_name || null,
      event_type: eventType,
      detail: detail || null,
      page: 'api',
    });
  } catch (_) { /* an audit line is never worth failing the action over */ }
}

// Wraps a handler so a thrown HttpError becomes its status, an unexpected
// error becomes a 500 with nothing leaked, and a non-POST gets 405.
export function handler(fn, { methods = ['POST'] } = {}) {
  return async (req, res) => {
    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    try {
      return await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error('Unhandled API error:', err);
      return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
    }
  };
}
