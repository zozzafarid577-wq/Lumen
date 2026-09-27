import { admin } from './supabase.js';
import { HttpError } from './auth.js';
import { generatePassword, findUserByEmail } from './util.js';
import { assertCanAddStudent } from './subscription.js';
import { sendEmail, accountReady, loginUrlFor } from './email.js';
import { sendPasswordInvite } from './invite.js';

// Creating a student account, from either direction: a teacher typing one
// in on the students page, or a teacher approving a registration that
// came in through a batch invite link.
//
// It lives here rather than in api/students.js because the two routes
// must not drift apart. A student who arrives through a link needs the
// same plan check, the same tenant checks on the courses named, the same
// rollback when half of it fails and the same welcome email as one typed
// in by hand — and "we fixed it in the other file" is how a second copy
// of this ends up missing one of them.
//
// Everything here runs with the service-role key, which ignores row-level
// security, so `teacherId` must always come from `tenantFor` in the
// caller and never from the request body.
// `password` is the student's own, typed by them on the registration
// page. When it is absent — a teacher typing a student in, who has no
// business choosing somebody else's password — the account is made with
// a random one that is never shown to anybody, and the student gets a
// link to set their own instead.
export async function createStudentAccount({
  teacherId, fullName, email, phone = null, parentPhone = null, parentEmail = null,
  courseIds = [], groupIds = {}, password = null, createdBy = null, req = null,
}) {
  if (!courseIds.length) throw new HttpError(400, 'Choose at least one course to enrol them on.');

  // The plan limit is checked here rather than in the browser, because
  // the browser is where a teacher can least be expected to be honest
  // with themselves about how many students they have.
  await assertCanAddStudent(teacherId);

  await assertCoursesAndGroups(teacherId, courseIds, groupIds);

  if (await findUserByEmail(admin, email)) {
    throw new HttpError(409, 'An account already exists for that email address.');
  }

  // Theirs if they chose one; otherwise a random string that exists only
  // so the auth user has something in the column. Nobody is ever told
  // it, and the link they are sent replaces it before it is used.
  const chosen = Boolean(password);
  const { data: created, error: uErr } = await admin.auth.admin.createUser({
    email,
    password: password || generatePassword(32),
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
      // Not "we gave them a password they must change" any more, but the
      // same question either way: is the password on this account one
      // they chose themselves?
      must_change_pw: !chosen,
    });
    if (pErr) throw new HttpError(500, 'Could not save that student’s profile.');

    const { error: eErr } = await admin.from('enrollments').insert(
      courseIds.map(course_id => ({
        teacher_id: teacherId, student_id: studentId, course_id,
        group_id: groupIds[course_id] || null,
      }))
    );
    if (eErr) throw new HttpError(500, 'The account was created but the enrolment failed. Please try again.');
  } catch (err) {
    // A student who can sign in but has no profile cannot be helped by
    // anyone: the portal signs them straight back out. Undo it all.
    try { await admin.auth.admin.deleteUser(studentId); } catch (_) {}
    throw err;
  }

  // The student should see whose space this is, not "Lumen" — they were
  // enrolled by a person, not by us.
  const { data: space } = await admin
    .from('teachers').select('display_name').eq('id', teacherId).maybeSingle();
  const spaceName = space?.display_name || null;

  // A student who chose their own password on the way in needs nothing
  // but a note of where the door is. One typed in by a teacher needs the
  // link, which comes back to the caller as well as going by email: mail
  // is the convenience, and a provider having a bad afternoon must not
  // leave a teacher with no way to let their student in.
  if (chosen) {
    // Their own password goes back to them in writing, in both
    // languages, because the one they just typed is the one they will
    // have forgotten by the next session.
    const mail = await sendEmail({
      to: email, toName: fullName,
      ...accountReady({ name: fullName, email, password, spaceName, loginUrl: loginUrlFor(req) }),
    });
    return { studentId, email, inviteUrl: null, emailSent: mail.sent, emailError: mail.error || null };
  }

  const invite = await sendPasswordInvite({
    student: { id: studentId, email, full_name: fullName, parent_email: parentEmail },
    teacherId, createdBy, spaceName, req, kind: 'welcome',
  });

  return {
    studentId, email, inviteUrl: invite.url, inviteExpiresAt: invite.expiresAt,
    emailSent: invite.emailSent, emailError: invite.emailError,
  };
}

// Courses named in a request must be this teacher's own. Otherwise a
// teacher could enrol their student onto a competitor's course by id.
//
// Groups are checked the same way, and twice over: a group id has to be
// this teacher's own AND belong to the course it is paired with, or an
// enrolment would name a class that meets for something else. The
// database enforces the pairing too — the foreign key is on
// (group_id, course_id) — but a 400 here says which one was wrong.
export async function assertCoursesAndGroups(teacherId, courseIds, groupIds = {}) {
  const { data: courses } = await admin
    .from('courses').select('id').eq('teacher_id', teacherId).in('id', courseIds);
  if ((courses?.length || 0) !== courseIds.length) {
    throw new HttpError(400, 'One of those courses is not in your space.');
  }

  const wanted = courseIds.map(cid => groupIds[cid]).filter(Boolean);
  if (!wanted.length) return;

  const { data: groups } = await admin
    .from('groups').select('id, course_id').eq('teacher_id', teacherId).in('id', wanted);
  const byId = new Map((groups || []).map(g => [g.id, g.course_id]));
  for (const cid of courseIds) {
    const gid = groupIds[cid];
    if (!gid) continue;
    if (!byId.has(gid)) throw new HttpError(400, 'One of those groups is not in your space.');
    if (byId.get(gid) !== cid) throw new HttpError(400, 'One of those groups belongs to a different course.');
  }
}
