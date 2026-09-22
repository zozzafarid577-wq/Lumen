import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, tenantFor, logActivity } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanText, generatePassword, findUserByEmail } from './_lib/util.js';

// The assistants a teacher brings in to help run their space.
//
// Only the teacher themselves (or Lumen staff acting for them) may do any
// of this: an assistant who could create assistants could grant themselves
// every permission their teacher withheld.
const VALID_PERMS = ['students', 'courses', 'questions', 'tests', 'assignments', 'announcements', 'reports'];

function cleanPerms(perms) {
  if (!Array.isArray(perms)) return [];
  return [...new Set(perms.filter(p => VALID_PERMS.includes(p)))];
}

export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['teacher', 'owner']);

  const body = req.body || {};
  const teacherId = tenantFor(profile, body.teacher_id);

  switch (body.action || 'create') {
    case 'create':      return createAssistant(res, profile, teacherId, body);
    case 'set_perms':   return setPerms(res, profile, teacherId, body);
    case 'set_active':  return setActive(res, profile, teacherId, body);
    case 'remove':      return remove(res, profile, teacherId, body);
    default: throw new HttpError(400, 'Unknown action.');
  }
});

async function createAssistant(res, actor, teacherId, body) {
  const fullName = cleanName(body.full_name, 'Assistant name');
  const email    = cleanEmail(body.email);
  const phone    = cleanText(body.phone, { max: 40 });
  const perms    = cleanPerms(body.staff_perms);

  if (!perms.length) throw new HttpError(400, 'Choose at least one thing this assistant may do.');
  if (await findUserByEmail(admin, email)) {
    throw new HttpError(409, 'An account already exists for that email address.');
  }

  const password = generatePassword();
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'assistant', teacher_id: teacherId },
    user_metadata: { full_name: fullName },
  });
  if (uErr || !created?.user) throw new HttpError(400, uErr?.message || 'Could not create that account.');

  const { error: pErr } = await admin.from('profiles').insert({
    id: created.user.id,
    teacher_id: teacherId,
    role: 'assistant',
    full_name: fullName,
    email,
    phone,
    staff_perms: perms,
    must_change_pw: true,
  });
  if (pErr) {
    try { await admin.auth.admin.deleteUser(created.user.id); } catch (_) {}
    throw new HttpError(500, 'Could not save that assistant’s profile.');
  }

  await logActivity(teacherId, actor, 'assistant_created', `${fullName} (${perms.join(', ')})`);
  return res.status(200).json({ assistant_id: created.user.id, email, password });
}

async function setPerms(res, actor, teacherId, body) {
  const staff = await getAssistant(body.staff_id, teacherId);
  const perms = cleanPerms(body.staff_perms);
  if (!perms.length) throw new HttpError(400, 'An assistant needs at least one permission. Remove them instead.');

  const { error } = await admin.from('profiles').update({ staff_perms: perms }).eq('id', staff.id);
  if (error) throw new HttpError(500, 'Could not update those permissions.');

  await logActivity(teacherId, actor, 'assistant_perms_changed', `${staff.full_name} → ${perms.join(', ')}`);
  return res.status(200).json({ ok: true, staff_perms: perms });
}

async function setActive(res, actor, teacherId, body) {
  const staff = await getAssistant(body.staff_id, teacherId);
  const active = body.is_active !== false;
  const { error } = await admin.from('profiles').update({ is_active: active }).eq('id', staff.id);
  if (error) throw new HttpError(500, 'Could not update that assistant.');

  await logActivity(teacherId, actor, active ? 'assistant_activated' : 'assistant_suspended', staff.full_name);
  return res.status(200).json({ ok: true, is_active: active });
}

async function remove(res, actor, teacherId, body) {
  const staff = await getAssistant(body.staff_id, teacherId);
  const { error } = await admin.auth.admin.deleteUser(staff.id);
  if (error) throw new HttpError(500, 'Could not remove that assistant.');

  // Their name stays on what they wrote — announcements keep a
  // created_by that is nulled rather than cascaded, so nothing a student
  // was reading disappears when an assistant leaves.
  await logActivity(teacherId, actor, 'assistant_removed', `${staff.full_name} <${staff.email}>`);
  return res.status(200).json({ ok: true });
}

async function getAssistant(staffId, teacherId) {
  if (!staffId) throw new HttpError(400, 'No assistant was named.');
  const { data, error } = await admin
    .from('profiles').select('id, full_name, email, role, teacher_id')
    .eq('id', staffId).single();
  if (error || !data) throw new HttpError(404, 'That assistant no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That account is not in your space.');
  // A teacher cannot demote, suspend or delete themselves through here.
  if (data.role !== 'assistant') throw new HttpError(400, 'That account is not an assistant.');
  return data;
}
