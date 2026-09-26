import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, requirePerm, tenantFor, logActivity } from './_lib/auth.js';
import { cleanText, generateToken } from './_lib/util.js';
import { createStudentAccount } from './_lib/students.js';
import { siteUrlFor } from './_lib/email.js';

// The teacher's half of batch invites: making a link for a class, and
// deciding what to do with the registrations it brings in.
//
// Reading is not here. The students page selects `invite_links` and
// `student_registrations` straight from Supabase, where the staff
// row-level-security policies already confine it to the teacher's own
// space. What needs the service-role key is approving — which creates an
// auth user — and so does closing the door on a link, which should be
// logged rather than done quietly from a browser.
export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['teacher', 'assistant', 'owner']);
  requirePerm(profile, 'students');

  const body = req.body || {};
  const teacherId = tenantFor(profile, body.teacher_id);
  const action = body.action || 'create';

  switch (action) {
    case 'create':   return createLink(res, profile, teacherId, body, req);
    case 'update':   return updateLink(res, profile, teacherId, body);
    case 'set_open': return setOpen(res, profile, teacherId, body);
    case 'delete':   return deleteLink(res, profile, teacherId, body);
    case 'approve':  return approve(res, profile, teacherId, body, req);
    case 'reject':   return reject(res, profile, teacherId, body);
    default: throw new HttpError(400, 'Unknown action.');
  }
});

// ── Making a link ─────────────────────────────────────────────────
async function createLink(res, actor, teacherId, body, req) {
  const courseId = body.course_id;
  const groupId  = body.group_id || null;
  if (!courseId) throw new HttpError(400, 'Choose which course this link enrols students on.');

  // Both ids have to be this teacher's own, and the group has to belong
  // to the course it is paired with — otherwise a link would drop its
  // students into a class that meets for something else.
  const { data: course } = await admin
    .from('courses').select('id, title').eq('id', courseId).eq('teacher_id', teacherId).maybeSingle();
  if (!course) throw new HttpError(400, 'That course is not in your space.');

  if (groupId) {
    const { data: group } = await admin
      .from('groups').select('id, course_id').eq('id', groupId).eq('teacher_id', teacherId).maybeSingle();
    if (!group) throw new HttpError(400, 'That group is not in your space.');
    if (group.course_id !== courseId) throw new HttpError(400, 'That group belongs to a different course.');
  }

  const maxUses = Number.isInteger(body.max_uses) && body.max_uses > 0 ? body.max_uses : null;
  const expires = body.expires_at ? new Date(body.expires_at) : null;
  if (expires && Number.isNaN(expires.getTime())) throw new HttpError(400, 'That closing date is not a real date.');

  // A token collision is a coin landing on its edge — 10 characters of
  // an alphabet of 57 — but a collision here would hand one teacher's
  // students to another, so it is retried rather than trusted.
  let token = null;
  let inserted = null;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    token = generateToken();
    const { data, error } = await admin.from('invite_links').insert({
      teacher_id: teacherId,
      course_id:  courseId,
      group_id:   groupId,
      token,
      label:      cleanText(body.label, { max: 80 }),
      max_uses:   maxUses,
      expires_at: expires ? expires.toISOString() : null,
      created_by: actor.id,
    }).select('id, token').maybeSingle();

    if (!error) { inserted = data; break; }
    if (error.code !== '23505') throw new HttpError(500, 'Could not create that link. Please try again.');
  }
  if (!inserted) throw new HttpError(500, 'Could not create that link. Please try again.');

  await logActivity(teacherId, actor, 'invite_link_created', `${course.title}${body.label ? ` · ${body.label}` : ''}`);

  return res.status(200).json({
    invite_id: inserted.id,
    token: inserted.token,
    url: siteUrlFor(req, `/join/${inserted.token}`),
  });
}

// ── Editing one ───────────────────────────────────────────────────
// Everything about a link except the link itself. The token is never
// written here: a teacher fixing a typo in a label must not silently
// break the URL already sitting in a class WhatsApp group, which is the
// one thing about a link that cannot be taken back.
//
// Moving a link to another course changes where the NEXT student who
// uses it lands. The ones who already registered keep the enrolment they
// were given, because that is where they actually are.
async function updateLink(res, actor, teacherId, body) {
  const link = await getLink(body.invite_id, teacherId);

  // The pair is validated together even when only one of them was sent,
  // because "keep the group, change the course" is the way to end up
  // with a link enrolling students into a class that meets for something
  // else. The database refuses that too — the foreign key is on
  // (group_id, course_id) — but a 400 here says which half was wrong.
  const courseId = body.course_id || link.course_id;
  const groupId  = body.group_id === undefined ? link.group_id : (body.group_id || null);

  const { data: course } = await admin
    .from('courses').select('id, title').eq('id', courseId).eq('teacher_id', teacherId).maybeSingle();
  if (!course) throw new HttpError(400, 'That course is not in your space.');

  if (groupId) {
    const { data: group } = await admin
      .from('groups').select('id, course_id').eq('id', groupId).eq('teacher_id', teacherId).maybeSingle();
    if (!group) throw new HttpError(400, 'That group is not in your space.');
    if (group.course_id !== courseId) throw new HttpError(400, 'That group belongs to a different course.');
  }

  const patch = { course_id: courseId, group_id: groupId };

  if ('label' in body) patch.label = cleanText(body.label, { max: 80 });

  if ('max_uses' in body) {
    patch.max_uses = Number.isInteger(body.max_uses) && body.max_uses > 0 ? body.max_uses : null;
  }

  if ('expires_at' in body) {
    const expires = body.expires_at ? new Date(body.expires_at) : null;
    if (expires && Number.isNaN(expires.getTime())) {
      throw new HttpError(400, 'That closing date is not a real date.');
    }
    patch.expires_at = expires ? expires.toISOString() : null;
  }

  const { error } = await admin.from('invite_links').update(patch).eq('id', link.id);
  if (error) throw new HttpError(500, 'Could not save that link.');

  await logActivity(teacherId, actor, 'invite_link_updated',
    `${course.title}${patch.label ? ` · ${patch.label}` : ''}`);

  return res.status(200).json({ ok: true });
}

// ── Opening and closing ───────────────────────────────────────────
// Closed rather than deleted, normally: the registrations a link brought
// in keep pointing at it, and a teacher who closes an intake this term
// usually reopens it next term.
async function setOpen(res, actor, teacherId, body) {
  const link = await getLink(body.invite_id, teacherId);
  const open = body.is_open === true;

  const { error } = await admin.from('invite_links').update({ is_open: open }).eq('id', link.id);
  if (error) throw new HttpError(500, 'Could not update that link.');

  await logActivity(teacherId, actor, open ? 'invite_link_opened' : 'invite_link_closed', link.label || link.token);
  return res.status(200).json({ ok: true, is_open: open });
}

async function deleteLink(res, actor, teacherId, body) {
  const link = await getLink(body.invite_id, teacherId);

  const { error } = await admin.from('invite_links').delete().eq('id', link.id);
  if (error) throw new HttpError(500, 'Could not delete that link.');

  await logActivity(teacherId, actor, 'invite_link_deleted', link.label || link.token);
  return res.status(200).json({ ok: true });
}

// ── Approving a registration ──────────────────────────────────────
// This is where a filled-in form becomes an account: the same call the
// students page makes when a teacher types one in by hand, so the plan
// check, the welcome email and the rollback are all the shared ones.
async function approve(res, actor, teacherId, body, req) {
  const reg = await getRegistration(body.registration_id, teacherId);
  if (reg.status !== 'pending') {
    throw new HttpError(409, reg.status === 'approved'
      ? 'That student has already been approved.'
      : 'That registration was turned down. Ask them to register again.');
  }
  if (!reg.course_id) {
    throw new HttpError(400,
      'The course this student registered for has since been deleted. '
      + 'Add them from “Add student” instead, choosing a course that still exists.');
  }

  // Claimed before the account is made, not after. Two assistants
  // clicking Approve at the same moment would otherwise both pass the
  // status check above and create two accounts for one student; the
  // row can only be claimed once, so the second one stops here.
  const { data: claimed } = await admin
    .from('student_registrations')
    .update({ status: 'approved', reviewed_by: actor.id, reviewed_at: new Date().toISOString() })
    .eq('id', reg.id).eq('status', 'pending')
    .select('id').maybeSingle();
  if (!claimed) throw new HttpError(409, 'Somebody else has just reviewed that registration.');

  let made;
  try {
    made = await createStudentAccount({
      teacherId,
      fullName:    reg.full_name,
      email:       reg.email,
      phone:       reg.phone,
      parentPhone: reg.parent_phone,
      parentEmail: reg.parent_email,
      courseIds:   [reg.course_id],
      groupIds:    reg.group_id ? { [reg.course_id]: reg.group_id } : {},
      createdBy:   actor.id,
      req,
    });
  } catch (err) {
    // The claim was a lock, not a decision. A plan that is full or an
    // email already taken elsewhere must leave the registration where
    // the teacher can see it and try again, not mark it done.
    await admin.from('student_registrations')
      .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
      .eq('id', reg.id);
    throw err;
  }

  await admin.from('student_registrations')
    .update({ student_id: made.studentId }).eq('id', reg.id);

  await logActivity(teacherId, actor, 'registration_approved', `${reg.full_name} <${reg.email}>`);

  // A link to set a password, not a password. Same handover as a student
  // typed in by hand, because it is the same account either way.
  return res.status(200).json({
    student_id: made.studentId,
    email: made.email,
    invite_url: made.inviteUrl,
    phone: reg.phone || reg.parent_phone || null,
    email_sent: made.emailSent,
    email_error: made.emailError,
  });
}

// ── Turning one down ──────────────────────────────────────────────
// A rejected row drops out of both unique indexes in migration v11, so
// this is also the "let them try again" button: a student who mistyped
// their email is otherwise locked out by their own first attempt.
async function reject(res, actor, teacherId, body) {
  const reg = await getRegistration(body.registration_id, teacherId);
  if (reg.status === 'approved') {
    throw new HttpError(409, 'That student already has an account. Remove them from the students list instead.');
  }

  const { error } = await admin.from('student_registrations').update({
    status: 'rejected',
    reviewed_by: actor.id,
    reviewed_at: new Date().toISOString(),
    review_note: cleanText(body.note, { max: 300 }),
  }).eq('id', reg.id);
  if (error) throw new HttpError(500, 'Could not update that registration.');

  await logActivity(teacherId, actor, 'registration_rejected', `${reg.full_name} <${reg.email}>`);
  return res.status(200).json({ ok: true });
}

// ── Shared ────────────────────────────────────────────────────────
// The tenant check that makes a service-role write safe: an id from
// another teacher's space is a 403, not a silent edit.
async function getLink(id, teacherId) {
  if (!id) throw new HttpError(400, 'No link was named.');
  const { data } = await admin
    .from('invite_links').select('id, teacher_id, token, label, course_id, group_id')
    .eq('id', id).maybeSingle();
  if (!data) throw new HttpError(404, 'That link no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That link is not in your space.');
  return data;
}

async function getRegistration(id, teacherId) {
  if (!id) throw new HttpError(400, 'No registration was named.');
  const { data } = await admin
    .from('student_registrations')
    .select('id, teacher_id, status, full_name, email, phone, parent_phone, parent_email, course_id, group_id')
    .eq('id', id).maybeSingle();
  if (!data) throw new HttpError(404, 'That registration no longer exists.');
  if (data.teacher_id !== teacherId) throw new HttpError(403, 'That registration is not in your space.');
  return data;
}
