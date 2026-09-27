import { admin } from './_lib/supabase.js';
import { handler, HttpError } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanText, phoneKey } from './_lib/util.js';
import { createStudentAccount } from './_lib/students.js';
import { runSetPassword } from './_lib/set-password.js';

// The one endpoint in api/ with no signed-in caller: a student opening
// their teacher's batch link has no account yet, which is the whole
// point of them being here.
//
// So the token is the only credential, and everything this returns or
// writes is decided from it. Two rules follow from that:
//
//   * Nothing is read from the request that names a tenant, a course or
//     a group. All three come off the invite row. A request body cannot
//     enrol anybody anywhere.
//   * Nothing goes back that the holder of the link should not already
//     know — the space name, the course, the class time. No student
//     list, no counts, no ids.
//
// A student who fills this in gets their account straight away: no
// queue, no approval, their sign-in on the screen in front of them.
// What stands between a stranger and an account is the link itself —
// closed, expired, used up or flooded are all refused above — plus the
// once-per-person rules below and the teacher's plan, which is checked
// before the account is made and not after.
//
// The registration row is still written. It is what makes "register
// once" enforceable rather than merely checked, and it is the record of
// who came in through which link. It is simply born approved now.

export default handler(async (req, res) => {
  const body = req.body || {};

  // The other flow that arrives here with a link and no account:
  // choosing a password from a set-up link. It lives in _lib and is
  // routed from here because Vercel's Hobby plan allows twelve
  // serverless functions per deployment, and api/ is at twelve — a
  // thirteenth file fails the deployment outright, while the last good
  // one carries on serving, so the site looks fine and simply stops
  // changing.
  if (body.flow === 'set-password') return runSetPassword(res, body, req);

  const action = body.action === 'submit' ? 'submit' : 'info';
  const invite = await openInvite(body.token);

  return action === 'submit' ? submit(res, invite, body, req) : info(res, invite);
});

// ── What the student is looking at ────────────────────────────────
async function info(res, invite) {
  return res.status(200).json({
    space_name:   invite.space_name,
    course_title: invite.course_title,
    group:        invite.group,
  });
}

// ── Registering ───────────────────────────────────────────────────
async function submit(res, invite, body, req) {
  const fullName    = cleanName(body.full_name, 'Your name');
  const email       = cleanEmail(body.email);
  const phone       = cleanText(body.phone, { max: 40 });
  const parentPhone = cleanText(body.parent_phone, { max: 40 });

  // Theirs, chosen on the form. Nobody generates a password for a
  // student any more: one that has to be shown on a screen or sent on to
  // reach them is one other people have seen.
  //
  // Checked here and not only in the page, because the page is the half
  // of this a determined student can skip.
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters.');
  if (password.length > 72) throw new HttpError(400, 'That password is too long — 72 characters at most.');

  // Required, not optional, because it is half of what says "this is the
  // same person" — and because a teacher with a class and no numbers for
  // it cannot reach anybody.
  const key = phoneKey(phone);
  if (!key) throw new HttpError(400, 'Please enter your mobile number so your teacher can reach you.');

  // The parent's details are required too. A teacher who needs to talk
  // to somebody's family about attendance or a result cannot do it
  // through a teenager's phone, and the moment they need it is never the
  // moment to start asking for it.
  //
  // Checked here and not only in the page, because the page is the half
  // of this a determined student can skip.
  if (!body.parent_email) {
    throw new HttpError(400, 'Please enter a parent’s email address.');
  }
  const parentEmail = cleanEmail(body.parent_email);

  if (!phoneKey(parentPhone)) {
    throw new HttpError(400, 'Please enter a parent’s mobile number.');
  }
  // Deliberately not added to the "have we seen this person" check
  // below. Siblings share a parent, and matching on the parent's number
  // would refuse the second child in a family as a duplicate of the
  // first.

  await assertNotFlooding(invite.id);
  const { nameFlag } = await screen(invite.teacher_id, { email, key, fullName });

  // Written before the account, not after, because this row is the lock.
  // The unique index on it is the only thing that stops two taps on a
  // slow connection becoming two accounts, and a check made in JavaScript
  // cannot do that job — both requests pass it before either has written.
  const { data: reg, error } = await admin.from('student_registrations').insert({
    teacher_id: invite.teacher_id,
    invite_id:  invite.id,
    course_id:  invite.course_id,
    group_id:   invite.group_id,
    full_name:  fullName,
    email,
    phone,
    parent_phone: parentPhone,
    parent_email: parentEmail,
    name_flag:  nameFlag,
    // Nobody reviewed it, so reviewed_by stays null. The row is the
    // record of a student who came in, not of a decision somebody made.
    status:     'approved',
    reviewed_at: new Date().toISOString(),
  }).select('id').single();

  if (error) {
    // 23505 is that index doing its job. Only one request lands, and the
    // loser is told the same thing it would have been told a moment
    // earlier.
    if (error.code === '23505') throw alreadyRegistered();
    throw new HttpError(500, 'Something went wrong saving your details. Please try again.');
  }

  // The plan limit, the account, the enrolment and the welcome email are
  // all in here, and it is the same call the teacher's own "Add student"
  // makes — so a student who registers themselves is the same student,
  // made the same way.
  let made;
  try {
    made = await createStudentAccount({
      teacherId:   invite.teacher_id,
      fullName,
      email,
      phone,
      parentPhone,
      parentEmail,
      courseIds:   [invite.course_id],
      groupIds:    invite.group_id ? { [invite.course_id]: invite.group_id } : {},
      password,
      req,
    });
  } catch (err) {
    // The row was a lock, not a record of anything that happened. It goes
    // again, or the student is barred from retrying by their own
    // abandoned attempt.
    await admin.from('student_registrations').delete().eq('id', reg.id);
    throw forStudent(err);
  }

  await admin.from('student_registrations')
    .update({ student_id: made.studentId }).eq('id', reg.id);

  // No password goes back, because none was ever made: the one on the
  // account is the one they typed into the form a moment ago, and it has
  // never been anywhere this endpoint could send it.
  return res.status(200).json({
    ok: true,
    space_name:   invite.space_name,
    course_title: invite.course_title,
    email:        made.email,
    email_sent:   made.emailSent,
  });
}

// Why an account could not be made is, with one exception, the teacher's
// business: a plan that is full, a subscription past due, a space with no
// subscription at all. None of that is for a stranger holding a link, so
// it is logged and the student is told to go and tell their teacher.
function forStudent(err) {
  if (err?.status === 409) return hasAccount();
  console.error('Join could not create an account:', err);
  return new HttpError(503,
    'Your teacher’s space cannot take new registrations right now. '
    + 'Please tell them you tried to register.');
}

// ── The token ─────────────────────────────────────────────────────
// Resolves a token to the batch it stands for, or refuses. Every reason
// to refuse gets the same 404 wording: a closed link, an expired one, a
// full one and one that never existed are all "this link is not taking
// registrations", because a stranger probing tokens should not learn
// which of those they hit.
async function openInvite(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token || token.length > 64) throw notOpen();

  const { data: invite } = await admin
    .from('invite_links')
    .select('id, teacher_id, course_id, group_id, is_open, expires_at, max_uses')
    .eq('token', token).maybeSingle();

  if (!invite || !invite.is_open) throw notOpen();
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) throw notOpen();

  if (invite.max_uses) {
    const { count } = await admin
      .from('student_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('invite_id', invite.id).neq('status', 'rejected');
    if ((count || 0) >= invite.max_uses) throw notOpen();
  }

  // Names for the page to show. A student should see whose space and
  // which class they are joining before they type anything — a link with
  // no context is a link nobody trusts.
  const [{ data: space }, { data: course }, group] = await Promise.all([
    admin.from('teachers').select('display_name').eq('id', invite.teacher_id).maybeSingle(),
    admin.from('courses').select('title').eq('id', invite.course_id).maybeSingle(),
    invite.group_id
      ? admin.from('groups').select('name, days, start_time').eq('id', invite.group_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    ...invite,
    space_name:   space?.display_name || null,
    course_title: course?.title || null,
    group:        group?.data || null,
  };
}

// ── Not being used as a hose ──────────────────────────────────────
// Registering once is enforced per person, which does nothing against
// somebody inventing a new email and a new number each time. A link that
// leaks out of a class group could otherwise be used to fill a teacher's
// review queue with hundreds of rows.
//
// Counted per link and per window rather than per IP, because the class
// this is meant for is a WhatsApp group on a handful of mobile networks —
// they share addresses, and the whole batch registering within a minute
// of the message arriving is the normal case, not the suspicious one.
//
// Serverless means there is nowhere to hold a counter between requests,
// so it is a count against the table. `max_uses` on the link is the
// teacher's own, stricter version of this.
const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_LIMIT = 40;

async function assertNotFlooding(inviteId) {
  const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
  const { count } = await admin
    .from('student_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('invite_id', inviteId).gt('submitted_at', since);

  if ((count || 0) >= BURST_LIMIT) {
    throw new HttpError(429,
      'This link has taken a lot of registrations in the last few minutes. '
      + 'Please wait a little and try again, or tell your teacher.');
  }
}

// ── Registering only once ─────────────────────────────────────────
// Checked against both halves of "already here": a form filled in
// earlier, and an account the teacher created by hand before sending the
// link out. The second matters more than it looks — a student whose
// teacher already enrolled them would otherwise fill this in, wait for
// an approval that can never work (their email is taken), and hear
// nothing.
//
// Refuses by throwing; returns only the name warning, which is not a
// refusal. Every comparison happens here in JS rather than in a filter
// string, because the values being compared were typed by a stranger:
// `.or('email_key.eq.' + email)` reads an email containing a comma as
// two more conditions, and `.ilike()` reads a name containing % as a
// wildcard that matches half the school.
async function screen(teacherId, { email, key, fullName }) {
  const [byEmail, byPhone] = await Promise.all([
    admin.from('student_registrations').select('id')
      .eq('teacher_id', teacherId).neq('status', 'rejected').eq('email_key', email).limit(1),
    admin.from('student_registrations').select('id')
      .eq('teacher_id', teacherId).neq('status', 'rejected').eq('phone_key', key).limit(1),
  ]);
  // Which one matched, not just that something did. "You are already
  // registered" to somebody who is certain they are not is a dead end;
  // "that mobile number is already registered" is something they can
  // act on, and something they can repeat to their teacher.
  if (byEmail.data?.length) throw alreadyRegistered('email');
  if (byPhone.data?.length) throw alreadyRegistered('phone');

  // One pass over the students already in this space, covering all three
  // comparisons. Phone numbers are stored as they were typed, so they
  // cannot be matched in the query at all — 0101… and +20101… are the
  // same number written two ways, and only phoneKey knows that. A
  // teacher's student list is bounded by their plan, and this runs once
  // per registration.
  const { data: students } = await admin
    .from('profiles').select('full_name, email, phone, parent_phone')
    .eq('teacher_id', teacherId).eq('role', 'student');

  const byAddress = (students || []).some(s => (s.email || '').trim().toLowerCase() === email);
  // Their own number or the one their parent gave. Both are checked,
  // because a teacher who enrolled them by hand may have had only one.
  const byNumber = (students || []).some(s =>
    phoneKey(s.phone) === key || phoneKey(s.parent_phone) === key);

  if (byAddress) throw hasAccount('email');
  if (byNumber) throw hasAccount('phone');

  // A name already in the space is worth telling the teacher about, and
  // worth nothing more than that: two real students called Mohamed Ali
  // is ordinary, and refusing the second one would turn a common name
  // into a locked door. Never a reason to fail the request.
  const wanted = norm(fullName);
  const nameFlag = (students || []).some(s => norm(s.full_name) === wanted);

  return { nameFlag };
}

function norm(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Both of these used to say the teacher would send sign-in details.
// Nobody sends details any more: registering makes the account on the
// spot with the password the student typed, so the thing to tell
// somebody who is already here is to go and use it.
function alreadyRegistered(what) {
  const which = what === 'phone'
    ? 'That mobile number has already been used to register in this class'
    : 'That email address has already been used to register in this class';
  return new HttpError(409,
    `${which} — once is all it takes, and the account is ready. `
    + 'Sign in with the password chosen when registering. '
    + 'If you cannot remember it, ask your teacher to send you a link to choose a new one. '
    + 'If you think this is somebody else, tell your teacher which one it is — they can see it.');
}

function hasAccount(what) {
  const which = what === 'phone'
    ? 'A student in this class already has that mobile number — either as their own or as a parent’s'
    : 'A student in this class already has that email address';
  return new HttpError(409,
    `${which}, so there is nothing to fill in here. `
    + 'Sign in with the password you chose. '
    + 'Forgotten it? Ask your teacher to send you a link to set a new one. '
    + 'If that account is not yours, tell your teacher — they can see which one it is and fix it.');
}

function notOpen() {
  return new HttpError(404,
    'This registration link is not taking new students. '
    + 'Ask your teacher for the current link.');
}
