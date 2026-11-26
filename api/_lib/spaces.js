import { admin } from './supabase.js';
import { HttpError } from './auth.js';

// One teacher, several subjects. Each subject is its own space — its own
// students, courses, tests and brand — but they hang off one main space
// (teachers.group_id, supabase-migration-v25.sql):
//
//   - one plan: the main space's subscription covers them all, and its
//     student places are shared across every subject;
//   - one sign-in: the teacher's account sits in whichever subject they
//     are working in (profiles.teacher_id and the token's teacher_id),
//     and switching moves it. Everything that reads "this space's data"
//     keeps reading one space, so nothing about the tenant line changes.
//
// A space with no group_id is a main space, alone or with subjects under it.

export const mainOf = (space) => space?.group_id || space?.id || null;

export async function getSpace(id) {
  const { data } = await admin.from('teachers').select('id, group_id, slug, display_name, subject, is_active').eq('id', id).maybeSingle();
  return data || null;
}

// Every space in the group `teacherId` belongs to, main space first.
export async function groupSpaces(teacherId) {
  const space = await getSpace(teacherId);
  if (!space) return [];
  const mainId = mainOf(space);
  const main = mainId === space.id ? space : await getSpace(mainId);
  // Two plain reads rather than one .or(): a filter string built from ids
  // is one more thing to get wrong.
  const { data, error } = await admin.from('teachers')
    .select('id, group_id, slug, display_name, subject, is_active').eq('group_id', mainId);
  if (error) throw new HttpError(500, 'Could not load the subjects in this space.');
  const subjects = (Array.isArray(data) ? data : []).filter(x => x.id !== mainId)
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  return [main || space, ...subjects];
}

export async function groupIds(teacherId) {
  const spaces = await groupSpaces(teacherId);
  return spaces.length ? spaces.map(s => s.id) : [teacherId];
}

// The teacher account of a group, wherever it is sitting at the moment.
export async function groupTeacher(teacherId) {
  const ids = await groupIds(teacherId);
  const { data } = await admin.from('profiles').select('id, full_name, email, phone, role, teacher_id')
    .in('teacher_id', ids).eq('role', 'teacher').limit(1);
  return (Array.isArray(data) ? data[0] : data) || null;
}

// Moves the teacher's sign-in to another subject of the same group. The
// profile and the token are written together; the browser refreshes its
// session afterwards so the new teacher_id is in the token it sends.
export async function switchSpace(profile, targetId) {
  if (profile.role !== 'teacher') throw new HttpError(403, 'Only the teacher can switch subjects.');
  if (!targetId) throw new HttpError(400, 'Choose a subject to switch to.');
  if (targetId === profile.teacher_id) return { teacher_id: targetId, unchanged: true };
  const ids = await groupIds(profile.teacher_id);
  if (!ids.includes(targetId)) throw new HttpError(403, 'That subject is not one of yours.');
  const target = await getSpace(targetId);
  if (!target?.is_active) throw new HttpError(403, 'That subject is paused. Contact Lumen to switch it back on.');

  const { error: aErr } = await admin.auth.admin.updateUserById(profile.id, {
    app_metadata: { role: 'teacher', teacher_id: targetId },
  });
  if (aErr) throw new HttpError(500, 'Could not switch subject. Please try again.');
  // profiles.teacher_id is guarded by a trigger; this function is the one
  // way past it, and only within the teacher's own group (migration v26).
  const { error: pErr } = await admin.rpc('move_teacher_within_group', { p_user: profile.id, p_target: targetId });
  if (pErr) {
    await admin.auth.admin.updateUserById(profile.id, { app_metadata: { role: 'teacher', teacher_id: profile.teacher_id } });
    throw new HttpError(500, 'Could not switch subject. Please try again.');
  }
  return { teacher_id: targetId };
}
