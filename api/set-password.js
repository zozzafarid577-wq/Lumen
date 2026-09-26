import { admin } from './_lib/supabase.js';
import { handler, HttpError } from './_lib/auth.js';
import { openPasswordInvite } from './_lib/invite.js';

// The second endpoint in api/ with no signed-in caller, for the same
// reason as the first: a student opening a set-up link has no password
// yet, which is what they are here to fix.
//
// The token is the only credential, so everything is decided from it:
//
//   * Nothing is read from the request that names a student, a tenant
//     or an email. All of it comes off the invite row. A request body
//     cannot set somebody else's password.
//   * Nothing goes back that the holder of the link should not already
//     know — their own name, their own address, whose space it is. No
//     ids, no anything about anybody else.
//   * The link is spent the moment it works, in the same breath as the
//     password is set.
export default handler(async (req, res) => {
  const body = req.body || {};
  const action = body.action === 'submit' ? 'submit' : 'info';
  const { invite, student } = await openPasswordInvite(body.token);

  return action === 'submit'
    ? submit(res, invite, student, body)
    : info(res, student);
});

// ── What the student is looking at ────────────────────────────────
async function info(res, student) {
  const { data: space } = await admin
    .from('teachers').select('display_name').eq('id', student.teacher_id).maybeSingle();

  return res.status(200).json({
    full_name: student.full_name,
    email: student.email,
    space_name: space?.display_name || null,
  });
}

// ── Choosing it ───────────────────────────────────────────────────
async function submit(res, invite, student, body) {
  const password = typeof body.password === 'string' ? body.password : '';

  // The same floor the portal's own change-password screen uses. Checked
  // here and not only in the page, because the page is the half of this
  // that can be skipped.
  if (password.length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters.');
  if (password.length > 72) throw new HttpError(400, 'That password is too long — 72 characters at most.');

  const { error } = await admin.auth.admin.updateUserById(student.id, { password });
  if (error) throw new HttpError(500, 'Could not set that password. Please try again.');

  // Spent, and in that order: a password that was set but a link that
  // stayed open is a link somebody else could still use. The other way
  // round only costs the student a second attempt.
  await admin.from('password_invites')
    .update({ used_at: new Date().toISOString() }).eq('token', invite.token);

  // The one thing this flow exists to make true.
  await admin.from('profiles').update({ must_change_pw: false }).eq('id', student.id);

  // Handed back so the page can sign them in with what they just chose,
  // rather than asking them to type it a third time.
  return res.status(200).json({ email: student.email });
}
