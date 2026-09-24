import { admin } from './_lib/supabase.js';
import { handler, HttpError } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanText, phoneKey } from './_lib/util.js';

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
// The registration this writes is not an account. Nobody can sign in
// from it. It becomes an account in api/invites.js when the teacher
// approves, and it takes up a place on their plan only then.

export default handler(async (req, res) => {
  const body = req.body || {};
  const action = body.action === 'submit' ? 'submit' : 'info';
  const invite = await openInvite(body.token);

  return action === 'submit' ? submit(res, invite, body) : info(res, invite);
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
async function submit(res, invite, body) {
  const fullName    = cleanName(body.full_name, 'Your name');
  const email       = cleanEmail(body.email);
  const phone       = cleanText(body.phone, { max: 40 });
  const parentPhone = cleanText(body.parent_phone, { max: 40 });
  const parentEmail = body.parent_email ? cleanEmail(body.parent_email) : null;

  // Required, not optional, because it is half of what says "this is the
  // same person" — and because a teacher with a class and no numbers for
  // it cannot reach anybody.
  const key = phoneKey(phone);
  if (!key) throw new HttpError(400, 'Please enter your mobile number so your teacher can reach you.');

  await assertNotFlooding(invite.id);
  const { nameFlag } = await screen(invite.teacher_id, { email, key, fullName });

  const { error } = await admin.from('student_registrations').insert({
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
  });

  if (error) {
    // 23505 is the unique index in migration v11 doing the job the check
    // above cannot: two taps on a slow connection are two requests that
    // both got past `assertNotRegistered` before either had written a
    // row. Only one of them lands, and the loser is told the same thing
    // it would have been told a moment earlier.
    if (error.code === '23505') throw alreadyRegistered();
    throw new HttpError(500, 'Something went wrong saving your details. Please try again.');
  }

  return res.status(200).json({
    ok: true,
    space_name: invite.space_name,
    course_title: invite.course_title,
  });
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
  if (byEmail.data?.length || byPhone.data?.length) throw alreadyRegistered();

  // One pass over the students already in this space, covering all three
  // comparisons. Phone numbers are stored as they were typed, so they
  // cannot be matched in the query at all — 0101… and +20101… are the
  // same number written two ways, and only phoneKey knows that. A
  // teacher's student list is bounded by their plan, and this runs once
  // per registration.
  const { data: students } = await admin
    .from('profiles').select('full_name, email, phone, parent_phone')
    .eq('teacher_id', teacherId).eq('role', 'student');

  const taken = (students || []).some(s =>
    (s.email || '').trim().toLowerCase() === email
    || phoneKey(s.phone) === key
    || phoneKey(s.parent_phone) === key);
  if (taken) throw hasAccount();

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

function alreadyRegistered() {
  return new HttpError(409,
    'You have already registered with this name, email or mobile number. '
    + 'You only need to register once — your teacher will send your sign-in details. '
    + 'If you have been waiting a while, message your teacher rather than filling this in again.');
}

function hasAccount() {
  return new HttpError(409,
    'You already have an account in this space, so there is nothing to fill in. '
    + 'Sign in at /login with the email and password your teacher sent you — '
    + 'use "Forgot password" there if you no longer have them.');
}

function notOpen() {
  return new HttpError(404,
    'This registration link is not taking new students. '
    + 'Ask your teacher for the current link.');
}
