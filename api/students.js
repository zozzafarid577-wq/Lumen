import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, requirePerm, tenantFor, logActivity } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanText, generatePassword, findUserByEmail } from './_lib/util.js';
import { assertCanAddStudent } from './_lib/subscription.js';
import { createStudentAccount } from './_lib/students.js';
import { sendEmail, passwordReset, signInEmailChanged, loginUrlFor } from './_lib/email.js';

// Everything a teacher does to a student account. Creating an auth user,
// setting a password and deleting an account all need the service-role
// key, which ignores row-level security — so every branch here starts
// from `tenantFor` and checks the student really is theirs.
export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['teacher', 'assistant', 'owner']);
  requirePerm(profile, 'students');

  const body = req.body || {};
  const teacherId = tenantFor(profile, body.teacher_id);
  const action = body.action || 'create';

  switch (action) {
    case 'create':         return createStudent(res, profile, teacherId, body, req);
    case 'update':         return updateStudent(res, profile, teacherId, body, req);
    case 'reset_password': return resetPassword(res, profile, teacherId, body, req);
    case 'set_active':     return setActive(res, profile, teacherId, body);
    case 'delete':         return deleteStudent(res, profile, teacherId, body);
    default: throw new HttpError(400, 'Unknown action.');
  }
});

// ── Create ────────────────────────────────────────────────────────
async function createStudent(res, actor, teacherId, body, req) {
  const fullName = cleanName(body.full_name, 'Student name');
  const email    = cleanEmail(body.email);
  const phone    = cleanText(body.phone, { max: 40 });
  const parentPhone = cleanText(body.parent_phone, { max: 40 });

  // A parent's details are required on a student a teacher types in, the
  // same as on one who registers themselves. A finished test's mark goes
  // to that address (api/result-email.js), and a teacher chasing
  // attendance cannot do it through a teenager's phone.
  //
  // Required here rather than inside createStudentAccount(), which the
  // batch-invite approval also calls: registrations taken before this
  // was asked for have no parent details, and refusing them would strand
  // a queue the teacher cannot empty any other way.
  if (!parentPhone) throw new HttpError(400, 'A parent’s phone number is required.');
  if (!body.parent_email) throw new HttpError(400, 'A parent’s email address is required.');
  const parentEmail = cleanEmail(body.parent_email);

  const courseIds = Array.isArray(body.course_ids) ? body.course_ids.filter(Boolean) : [];
  // { course_id: group_id } for the courses where a group was chosen.
  const groupIds = (body.group_ids && typeof body.group_ids === 'object') ? body.group_ids : {};

  // The plan check, the tenant checks on the courses named, the account,
  // the enrolments, the rollback and the welcome email all live in
  // _lib/students.js, because approving a registration from a batch
  // invite link has to do exactly the same things.
  const made = await createStudentAccount({
    teacherId, fullName, email, phone, parentPhone, parentEmail, courseIds, groupIds, req,
  });

  await logActivity(teacherId, actor, 'student_created', `${fullName} <${email}>`);

  return res.status(200).json({
    student_id: made.studentId, email: made.email, password: made.password,
    email_sent: made.emailSent, email_error: made.emailError,
  });
}

// ── Update ────────────────────────────────────────────────────────
// Everything about a student that a teacher can correct. The details
// on the profile go through plainly; the sign-in email is the one that
// has to move in two places at once, so it is written first and put
// back if the profile write then fails.
async function updateStudent(res, actor, teacherId, body, req) {
  const student = await getStudent(body.student_id, teacherId);

  const patch = {};
  const changed = [];

  if (body.full_name !== undefined) {
    const name = cleanName(body.full_name, 'Student name');
    if (name !== student.full_name) { patch.full_name = name; changed.push('name'); }
  }

  // Both of these are "or clear it": a phone number that was typed wrong
  // has to be removable, not only replaceable. cleanText returns null for
  // an empty string, which is exactly that.
  for (const [field, label, max] of [['phone', 'phone', 40], ['parent_phone', 'parent phone', 40]]) {
    if (body[field] === undefined) continue;
    const value = cleanText(body[field], { max });
    if (value !== (student[field] || null)) { patch[field] = value; changed.push(label); }
  }

  if (body.parent_email !== undefined) {
    const raw = String(body.parent_email || '').trim();
    const value = raw ? cleanEmail(raw) : null;
    if (value !== (student.parent_email || null)) { patch.parent_email = value; changed.push('parent email'); }
  }

  let emailChange = null;
  if (body.email !== undefined) {
    const email = cleanEmail(body.email);
    if (email !== (student.email || '').toLowerCase()) {
      const existing = await findUserByEmail(admin, email);
      if (existing && existing.id !== student.id) {
        throw new HttpError(409, 'An account already exists for that email address.');
      }
      emailChange = { from: student.email, to: email };
      patch.email = email;
      changed.push('sign-in email');
    }
  }

  if (!changed.length) return res.status(200).json({ ok: true, changed: [] });

  // The sign-in is the write that can be refused for a reason no check
  // here can see, so it goes first and nothing else happens if it fails.
  if (emailChange) {
    const { error } = await admin.auth.admin.updateUserById(student.id, {
      email: emailChange.to,
      email_confirm: true,
    });
    if (error) throw new HttpError(400, error.message || 'Could not change that sign-in email.');
  }

  const { error } = await admin.from('profiles').update(patch).eq('id', student.id);
  if (error) {
    // A sign-in that has moved on without the profile is the worst of
    // the states to be left in: the student would be told to use an
    // address their teacher cannot see. Put it back.
    if (emailChange) {
      try {
        await admin.auth.admin.updateUserById(student.id, { email: emailChange.from, email_confirm: true });
      } catch (_) { /* reported either way */ }
    }
    throw new HttpError(500, 'Could not update that student. Nothing was changed.');
  }

  await logActivity(teacherId, actor, 'student_updated', `${patch.full_name || student.full_name} · ${changed.join(', ')}`);

  // Only a changed sign-in address is worth a message — the student has
  // to know what to type next time. A corrected phone number is not news.
  let mail = { sent: false };
  if (emailChange) {
    const { data: space } = await admin.from('teachers').select('display_name').eq('id', teacherId).maybeSingle();
    mail = await sendEmail({
      to: emailChange.to,
      toName: patch.full_name || student.full_name,
      ...signInEmailChanged({
        name: patch.full_name || student.full_name,
        oldEmail: emailChange.from,
        newEmail: emailChange.to,
        spaceName: space?.display_name || 'Lumen',
        loginUrl: loginUrlFor(req),
      }),
    });
  }

  return res.status(200).json({ ok: true, changed, email_sent: mail.sent });
}

// ── Reset password ────────────────────────────────────────────────
async function resetPassword(res, actor, teacherId, body, req) {
  const student = await getStudent(body.student_id, teacherId);
  const password = generatePassword();

  const { error } = await admin.auth.admin.updateUserById(student.id, { password });
  if (error) throw new HttpError(500, 'Could not reset that password. Please try again.');

  // Back to a password somebody else has seen, so it has to be changed
  // again on the next sign-in.
  await admin.from('profiles').update({ must_change_pw: true }).eq('id', student.id);
  await logActivity(teacherId, actor, 'student_password_reset', student.full_name);

  const mail = await sendEmail({
    to: student.email, toName: student.full_name,
    ...passwordReset({ name: student.full_name, email: student.email, password, loginUrl: loginUrlFor(req) }),
  });

  return res.status(200).json({ email: student.email, password, email_sent: mail.sent, email_error: mail.error || null });
}

// ── Activate / deactivate ─────────────────────────────────────────
async function setActive(res, actor, teacherId, body) {
  const student = await getStudent(body.student_id, teacherId);
  const active = body.is_active !== false;

  // Switching someone back on takes up a place on the plan again, so it
  // goes through the same check as creating them.
  if (active && !student.is_active) await assertCanAddStudent(teacherId);

  const { error } = await admin.from('profiles').update({ is_active: active }).eq('id', student.id);
  if (error) throw new HttpError(500, 'Could not update that student.');

  // Supabase keeps issuing tokens to a banned user until the current one
  // expires; the portal's own is_active check is what closes the gap.
  await logActivity(teacherId, actor, active ? 'student_activated' : 'student_deactivated', student.full_name);
  return res.status(200).json({ ok: true, is_active: active });
}

// ── Delete ────────────────────────────────────────────────────────
async function deleteStudent(res, actor, teacherId, body) {
  const student = await getStudent(body.student_id, teacherId);

  // Deleting the auth user cascades to the profile and everything hanging
  // off it — results included. Teachers reach for this expecting
  // "remove from my list", so the portal asks for the student's name to be
  // typed first, and offers deactivating instead.
  const { error } = await admin.auth.admin.deleteUser(student.id);
  if (error) throw new HttpError(500, 'Could not delete that account.');

  await logActivity(teacherId, actor, 'student_deleted', `${student.full_name} <${student.email}>`);
  return res.status(200).json({ ok: true });
}

// ── Shared ────────────────────────────────────────────────────────
// The tenant check that makes a service-role write safe: a student id
// from another teacher's space is a 403, not a silent edit.
async function getStudent(studentId, teacherId) {
  if (!studentId) throw new HttpError(400, 'No student was named.');
  const { data, error } = await admin
    .from('profiles').select('id, full_name, email, role, teacher_id, is_active, phone, parent_phone, parent_email')
    .eq('id', studentId).single();
  if (error || !data) throw new HttpError(404, 'That student no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That student is not in your space.');
  if (data.role !== 'student') throw new HttpError(400, 'That account is not a student.');
  return data;
}
