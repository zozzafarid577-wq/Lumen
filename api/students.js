import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, requirePerm, tenantFor, logActivity } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanText, generatePassword, findUserByEmail } from './_lib/util.js';
import { assertCanAddStudent } from './_lib/subscription.js';
import { sendEmail, studentWelcome, passwordReset, loginUrlFor } from './_lib/email.js';

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
  const parentEmail = body.parent_email ? cleanEmail(body.parent_email) : null;
  const courseIds = Array.isArray(body.course_ids) ? body.course_ids.filter(Boolean) : [];

  if (!courseIds.length) throw new HttpError(400, 'Choose at least one course to enrol them on.');

  // The plan limit is checked here rather than in the browser, because
  // the browser is where a teacher can least be expected to be honest
  // with themselves about how many students they have.
  await assertCanAddStudent(teacherId);

  // Courses named in the request must be this teacher's own. Otherwise a
  // teacher could enrol their student onto a competitor's course by id.
  const { data: courses } = await admin
    .from('courses').select('id').eq('teacher_id', teacherId).in('id', courseIds);
  if ((courses?.length || 0) !== courseIds.length) {
    throw new HttpError(400, 'One of those courses is not in your space.');
  }

  if (await findUserByEmail(admin, email)) {
    throw new HttpError(409, 'An account already exists for that email address.');
  }

  const password = generatePassword();
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: 'student', teacher_id: teacherId },
    user_metadata: { full_name: fullName },
  });
  if (uErr || !created?.user) throw new HttpError(400, uErr?.message || 'Could not create that account.');
  const studentId = created.user.id;

  try {
    const { error: pErr } = await admin.from('profiles').insert({
      id: studentId,
      teacher_id: teacherId,
      role: 'student',
      full_name: fullName,
      email,
      phone,
      parent_phone: parentPhone,
      parent_email: parentEmail,
      must_change_pw: true,
    });
    if (pErr) throw new HttpError(500, 'Could not save that student’s profile.');

    const { error: eErr } = await admin.from('enrollments').insert(
      courseIds.map(course_id => ({ teacher_id: teacherId, student_id: studentId, course_id }))
    );
    if (eErr) throw new HttpError(500, 'The account was created but the enrolment failed. Please try again.');
  } catch (err) {
    // A student who can sign in but has no profile cannot be helped by
    // anyone: the portal signs them straight back out. Undo it all.
    try { await admin.auth.admin.deleteUser(studentId); } catch (_) {}
    throw err;
  }

  await logActivity(teacherId, actor, 'student_created', `${fullName} <${email}>`);

  // Email is a convenience on top of the handover, never a replacement
  // for it: the password comes back either way, and a mail provider
  // having a bad afternoon must not undo a student who now exists.
  // The student should see whose space this is, not "Lumen" — they were
  // enrolled by a person, not by us.
  const { data: space } = await admin
    .from('teachers').select('display_name').eq('id', teacherId).single();

  const mail = await sendEmail({
    to: email, toName: fullName,
    ...studentWelcome({
      name: fullName, email, password,
      spaceName: space?.display_name || null,
      loginUrl: loginUrlFor(req),
    }),
  });

  return res.status(200).json({ student_id: studentId, email, password, email_sent: mail.sent, email_error: mail.error || null });
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
    .from('profiles').select('id, full_name, email, role, teacher_id, is_active')
    .eq('id', studentId).single();
  if (error || !data) throw new HttpError(404, 'That student no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That student is not in your space.');
  if (data.role !== 'student') throw new HttpError(400, 'That account is not a student.');
  return data;
}
