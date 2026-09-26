import { admin } from './supabase.js';
import { HttpError } from './auth.js';
import { generateToken } from './util.js';
import { sendEmail, studentInvite, siteUrlFor } from './email.js';

// The link a student uses to choose their own password.
//
// It exists because the alternative was handing them one. A generated
// password has to be read out, typed into WhatsApp or written on paper
// to reach the student at all, and every one of those leaves a working
// credential somewhere it cannot be taken back from. A link expires,
// can only be spent once, and stops working the moment a newer one is
// made.
//
// Everything here runs with the service-role key. `teacherId` must come
// from `tenantFor` in the caller, never from a request body.

// Long enough to survive a message read at the weekend, short enough
// that a link left in a class group chat does not open an account a
// term later.
export const INVITE_DAYS = 14;

// One live link per student. Issuing a new one deletes the unused ones
// before it, so a teacher who sends a second link has not left the
// first working — "I'll send you another" has to mean the old one is
// dead, or it is not a fix for a link that went to the wrong number.
export async function issuePasswordInvite({ studentId, teacherId, createdBy = null, req }) {
  await admin.from('password_invites')
    .delete().eq('student_id', studentId).is('used_at', null);

  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // A token collision is a coin landing on its edge — 16 characters of
  // an alphabet of 57 — but this one would hand a stranger somebody's
  // account, so it is retried rather than trusted.
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateToken(16);
    const { error } = await admin.from('password_invites').insert({
      token, student_id: studentId, teacher_id: teacherId,
      created_by: createdBy, expires_at: expiresAt,
    });

    if (!error) return { token, url: siteUrlFor(req, `/setup/${token}`), expiresAt };
    if (error.code !== '23505') throw new HttpError(500, 'Could not make a sign-in link. Please try again.');
  }
  throw new HttpError(500, 'Could not make a sign-in link. Please try again.');
}

// Issue one and email it. The link comes back either way: email is the
// convenience, and the teacher still has a link to hand over when a mail
// provider is having a bad afternoon — or when the student's address was
// their parent's all along.
export async function sendPasswordInvite({ student, teacherId, createdBy = null, spaceName = null, req, kind = 'welcome' }) {
  const invite = await issuePasswordInvite({ studentId: student.id, teacherId, createdBy, req });

  const mail = await sendEmail({
    to: student.email, toName: student.full_name,
    ...studentInvite({
      name: student.full_name, email: student.email,
      spaceName, setupUrl: invite.url, days: INVITE_DAYS, kind,
    }),
  });

  return { ...invite, emailSent: mail.sent, emailError: mail.error || null };
}

// The other half: what the public page does with the token it was
// opened with. Kept here so that the rules a link is judged by are
// written once — not spent, not expired, student still active.
export async function openPasswordInvite(token) {
  if (!token || typeof token !== 'string') throw new HttpError(400, 'That link is not complete.');

  const { data: invite } = await admin
    .from('password_invites')
    .select('token, student_id, teacher_id, expires_at, used_at')
    .eq('token', token).maybeSingle();

  // One message for a token that never existed and one for a token that
  // has been spent. Telling a stranger which is which says nothing
  // useful about anybody, and telling a student who tapped twice that
  // their link "does not exist" sends them back to their teacher for
  // no reason.
  if (!invite) throw new HttpError(404, 'This link is not valid. Ask your teacher for a new one.');
  if (invite.used_at) throw new HttpError(410, 'This link has already been used. If that was you, sign in with the password you chose.');
  if (new Date(invite.expires_at) < new Date()) throw new HttpError(410, 'This link has expired. Ask your teacher for a new one.');

  const { data: student } = await admin
    .from('profiles').select('id, full_name, email, role, is_active, teacher_id')
    .eq('id', invite.student_id).maybeSingle();

  if (!student || student.role !== 'student') throw new HttpError(404, 'This link is not valid. Ask your teacher for a new one.');
  if (!student.is_active) throw new HttpError(403, 'This account is not active. Please speak to your teacher.');

  return { invite, student };
}
