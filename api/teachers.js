import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, logActivity } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanSlug, cleanText, generatePassword, findUserByEmail } from './_lib/util.js';
import { sendEmail, teacherWelcome, signInEmailChanged, loginUrlFor } from './_lib/email.js';

// The Lumen console: opening a teacher's space, putting them on a plan,
// and raising the invoices that go with it.
//
// Every branch is owner-only. This is the one file where a caller can act
// on a tenant that is not their own, which is exactly why there is no
// teacher or assistant path through it.
export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, 'owner');

  const body = req.body || {};
  switch (body.action || 'create') {
    case 'create':        return createSpace(res, profile, body, req);
    case 'update':        return updateSpace(res, profile, body, req);
    case 'set_plan':      return setPlan(res, profile, body);
    case 'set_active':    return setActive(res, profile, body);
    case 'add_invoice':   return addInvoice(res, profile, body);
    case 'mark_paid':     return markPaid(res, profile, body);
    case 'delete_preview':return deletePreview(res, body);
    case 'delete':        return deleteSpace(res, profile, body);
    default: throw new HttpError(400, 'Unknown action.');
  }
});

// ── Open a teacher's space ────────────────────────────────────────
// The setup fee in the price list buys this step: Lumen creates the
// space, the teacher's sign-in, and the subscription in one go, and hands
// over a password.
async function createSpace(res, actor, body, req) {
  const fullName = cleanName(body.full_name, 'Teacher name');
  const email    = cleanEmail(body.email);
  const spaceName = cleanName(body.display_name || fullName, 'Space name');
  const slug     = cleanSlug(body.slug || spaceName);
  const subject  = cleanText(body.subject, { max: 80 });
  const phone    = cleanText(body.phone, { max: 40 });
  const planCode = body.plan_code || null;

  const plan = planCode ? await getPlan(planCode) : null;

  if (await findUserByEmail(admin, email)) {
    throw new HttpError(409, 'An account already exists for that email address.');
  }
  const { data: taken } = await admin.from('teachers').select('id').eq('slug', slug).maybeSingle();
  if (taken) throw new HttpError(409, 'That space name is already taken.');

  const { data: teacher, error: tErr } = await admin.from('teachers').insert({
    slug, display_name: spaceName, subject, contact_email: email, contact_phone: phone,
  }).select().single();
  if (tErr) throw new HttpError(500, 'Could not create that space.');

  const password = generatePassword();
  let userId = null;
  try {
    const { data: created, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: 'teacher', teacher_id: teacher.id },
      user_metadata: { full_name: fullName },
    });
    if (uErr || !created?.user) throw new HttpError(400, uErr?.message || 'Could not create that account.');
    userId = created.user.id;

    const { error: pErr } = await admin.from('profiles').insert({
      id: userId, teacher_id: teacher.id, role: 'teacher',
      full_name: fullName, email, phone, must_change_pw: true,
    });
    if (pErr) throw new HttpError(500, 'Could not save that teacher’s profile.');

    const now = new Date();
    await admin.from('subscriptions').insert({
      teacher_id: teacher.id,
      plan_code: plan?.code ?? null,
      status: plan ? 'active' : 'trial',
      student_limit: plan?.student_limit ?? 10,
      monthly_fee_egp: plan?.monthly_fee_egp ?? 0,
      setup_fee_egp: plan?.setup_fee_egp ?? 0,
      current_period_start: now.toISOString(),
      current_period_end: addMonth(now).toISOString(),
      notes: cleanText(body.notes, { max: 500 }),
    });

    // The one-off setup fee and the first month, raised together so the
    // teacher's first invoice matches what they were quoted.
    if (plan) {
      const rows = [];
      if (plan.setup_fee_egp > 0) {
        rows.push({ teacher_id: teacher.id, kind: 'setup', amount_egp: plan.setup_fee_egp,
                    description: 'Initial setup' });
      }
      if (plan.monthly_fee_egp > 0) {
        rows.push({ teacher_id: teacher.id, kind: 'monthly', amount_egp: plan.monthly_fee_egp,
                    description: plan.name,
                    period_start: isoDate(now), period_end: isoDate(addMonth(now)) });
      }
      if (rows.length) await admin.from('invoices').insert(rows);
    }
  } catch (err) {
    if (userId) { try { await admin.auth.admin.deleteUser(userId); } catch (_) {} }
    try { await admin.from('teachers').delete().eq('id', teacher.id); } catch (_) {}
    throw err;
  }

  await logActivity(teacher.id, actor, 'space_created', `${spaceName} <${email}>`);

  const mail = await sendEmail({
    to: email, toName: fullName,
    ...teacherWelcome({ name: fullName, email, password, spaceName, loginUrl: loginUrlFor(req) }),
  });

  return res.status(200).json({
    teacher_id: teacher.id, slug, email, password,
    email_sent: mail.sent, email_error: mail.error || null,
  });
}

// ── Correct a space that is already open ──────────────────────────
// A teacher's settings page lets them fix their own name, their space's
// display name and most of the rest. Two things it cannot touch are the
// address they sign in with and the slug their space lives at — it tells
// them to contact Lumen about the first, and this is where Lumen does it.
//
// Every field is optional: a key left out of the body is left alone, so
// the console can send only what its form holds without wiping the
// columns it does not show.
async function updateSpace(res, actor, body, req) {
  const teacher = await getTeacher(body.teacher_id);
  const person  = await getTeacherProfile(teacher.id);

  const changed = [];
  const spacePatch = {};
  const personPatch = {};

  if (body.display_name !== undefined) {
    const displayName = cleanName(body.display_name, 'Space name');
    if (displayName !== teacher.display_name) {
      spacePatch.display_name = displayName;
      changed.push(`name → ${displayName}`);
    }
  }

  if (body.subject !== undefined) {
    const subject = cleanText(body.subject, { max: 80 });
    if (subject !== teacher.subject) {
      spacePatch.subject = subject;
      changed.push(`subject → ${subject || '—'}`);
    }
  }

  // The slug is in URLs, in the sign-in hint students are given, and it
  // is the word typed back to delete a space. Changing it is allowed —
  // a space opened under a misspelling is stuck with it otherwise — but
  // it has to clear the same checks as a brand new one.
  if (body.slug !== undefined) {
    const slug = cleanSlug(body.slug);
    if (slug !== teacher.slug) {
      const { data: taken } = await admin.from('teachers').select('id').eq('slug', slug).maybeSingle();
      if (taken && taken.id !== teacher.id) throw new HttpError(409, 'That space name is already taken.');
      spacePatch.slug = slug;
      changed.push(`slug ${teacher.slug} → ${slug}`);
    }
  }

  if (body.full_name !== undefined) {
    const fullName = cleanName(body.full_name, 'Teacher name');
    requirePerson(person, 'nobody to rename');
    if (fullName !== person.full_name) {
      personPatch.full_name = fullName;
      changed.push(`teacher → ${fullName}`);
    }
  }

  if (body.phone !== undefined) {
    const phone = cleanText(body.phone, { max: 40 });
    if (person && phone !== person.phone) personPatch.phone = phone;
    if (phone !== teacher.contact_phone) spacePatch.contact_phone = phone;
    if (personPatch.phone !== undefined || spacePatch.contact_phone !== undefined) {
      changed.push(`phone → ${phone || '—'}`);
    }
  }

  // The address is in three places: auth.users is what they sign in
  // with, profiles.email is what every portal list reads, and
  // teachers.contact_email is what Lumen writes to. All three move
  // together or the teacher ends up with an account that answers to one
  // address and is addressed at another.
  let emailChange = null;
  if (body.email !== undefined) {
    const email = cleanEmail(body.email);
    const current = person?.email || teacher.contact_email || null;
    if (email !== current) {
      requirePerson(person, 'no sign-in email to change');
      const existing = await findUserByEmail(admin, email);
      if (existing && existing.id !== person.id) {
        throw new HttpError(409, 'An account already exists for that email address.');
      }
      emailChange = { from: current, to: email };
      personPatch.email = email;
      spacePatch.contact_email = email;
      changed.push(`email ${current || '—'} → ${email}`);
    }
  }

  if (!changed.length) return res.status(200).json({ ok: true, changed: [] });

  // Written riskiest-first, so a failure leaves as little behind as it
  // can: the sign-in is the one write that can be refused for a reason
  // no check here can see.
  if (emailChange) {
    const { error } = await admin.auth.admin.updateUserById(person.id, {
      email: emailChange.to,
      email_confirm: true,
    });
    if (error) throw new HttpError(400, error.message || 'Could not change that sign-in email.');
  }

  if (Object.keys(personPatch).length) {
    const { error } = await admin.from('profiles').update(personPatch).eq('id', person.id);
    if (error) {
      // A sign-in that has moved on without the profile is the worst of
      // the three states — the teacher's own portal would still show the
      // old address — so put it back and report the whole thing failed.
      if (emailChange) {
        try {
          await admin.auth.admin.updateUserById(person.id, { email: emailChange.from, email_confirm: true });
        } catch (_) { /* reported below either way */ }
      }
      throw new HttpError(500, 'Could not update that teacher’s account. Nothing was changed.');
    }
  }

  if (Object.keys(spacePatch).length) {
    const { error } = await admin.from('teachers').update(spacePatch).eq('id', teacher.id);
    // Re-running finishes the job: by now the new email is already the
    // current one, so a second attempt simply skips it and writes the
    // space row.
    if (error) throw new HttpError(500, 'The teacher’s account was updated but the space details were not. Please try again.');
  }

  await logActivity(teacher.id, actor, 'space_updated', changed.join(' · '));

  // Only a changed sign-in email is worth a message. Renaming a space is
  // something the teacher can see for themselves next time they look.
  let mail = { sent: false };
  if (emailChange) {
    mail = await sendEmail({
      to: emailChange.to,
      toName: personPatch.full_name || person.full_name,
      ...signInEmailChanged({
        name: personPatch.full_name || person.full_name,
        oldEmail: emailChange.from,
        newEmail: emailChange.to,
        spaceName: spacePatch.display_name || teacher.display_name,
        loginUrl: loginUrlFor(req),
      }),
    });
  }

  return res.status(200).json({
    ok: true,
    changed,
    slug: spacePatch.slug || teacher.slug,
    email_sent: mail.sent,
    email_error: mail.error || null,
  });
}

// Most of a space can be corrected with nobody signed in to it — a space
// whose teacher account failed half-way through being opened still has a
// name and a slug worth fixing. The fields that live on the person do
// not, and saying so beats a 500 from an update on `undefined`.
function requirePerson(person, what) {
  if (!person) throw new HttpError(409, `This space has no teacher account, so there is ${what}.`);
  return person;
}

// ── Move a teacher onto a plan ────────────────────────────────────
async function setPlan(res, actor, body) {
  const teacher = await getTeacher(body.teacher_id);
  const plan = body.plan_code ? await getPlan(body.plan_code) : null;

  const patch = {
    plan_code: plan?.code ?? null,
    status: body.status || 'active',
  };
  if (plan) {
    patch.student_limit   = plan.student_limit;
    patch.monthly_fee_egp = plan.monthly_fee_egp;
    patch.setup_fee_egp   = plan.setup_fee_egp;
  }
  // A limit set by hand beats the plan's — a teacher part-way between two
  // tiers should not have to be moved up a whole tier to gain five places.
  if (Number.isInteger(body.student_limit)) {
    if (body.student_limit < 0 || body.student_limit > 5000) throw new HttpError(400, 'That student limit is not sensible.');
    patch.student_limit = body.student_limit;
  }
  if (body.status === 'cancelled') patch.cancelled_at = new Date().toISOString();
  if (body.notes !== undefined) patch.notes = cleanText(body.notes, { max: 500 });

  const { error } = await admin.from('subscriptions').update(patch).eq('teacher_id', teacher.id);
  if (error) throw new HttpError(500, 'Could not update that subscription.');

  await logActivity(teacher.id, actor, 'subscription_changed',
    `${plan?.name || 'custom'} · ${patch.status} · ${patch.student_limit ?? '—'} students`);
  return res.status(200).json({ ok: true });
}

// ── Pause or reopen a space ───────────────────────────────────────
async function setActive(res, actor, body) {
  const teacher = await getTeacher(body.teacher_id);
  const active = body.is_active !== false;

  // Pausing hides the portal from everyone in the space. It deletes
  // nothing: the teacher's courses, students and results are all still
  // there when it is switched back on.
  const { error } = await admin.from('teachers').update({ is_active: active }).eq('id', teacher.id);
  if (error) throw new HttpError(500, 'Could not update that space.');

  await logActivity(teacher.id, actor, active ? 'space_reopened' : 'space_paused', teacher.display_name);
  return res.status(200).json({ ok: true, is_active: active });
}

// ── Deleting a space ──────────────────────────────────────────────
// The most destructive thing in the product: a teacher's courses, their
// students' accounts, and every result those students ever recorded.
// Nothing about it is recoverable, so it is deliberately awkward — the
// caller has to have seen what they are about to destroy and type the
// space's slug back.

// What the confirmation dialog shows. Counted with the service-role
// client because Lumen staff deliberately have no read policy over
// teaching content — they can see that a space has 40 tests, not what
// is in them.
async function deletePreview(res, body) {
  const teacher = await getTeacher(body.teacher_id);
  const counts = await countTenant(teacher.id);
  return res.status(200).json({
    teacher: { id: teacher.id, slug: teacher.slug, display_name: teacher.display_name },
    counts,
    confirm_with: teacher.slug,
  });
}

async function countTenant(teacherId) {
  const count = async (table, extra = q => q) => {
    const { count: n } = await extra(
      admin.from(table).select('id', { count: 'exact', head: true }).eq('teacher_id', teacherId));
    return n || 0;
  };
  const [students, assistants, courses, tests, attempts, submissions] = await Promise.all([
    count('profiles', q => q.eq('role', 'student')),
    count('profiles', q => q.eq('role', 'assistant')),
    count('courses'),
    count('practice_tests'),
    count('test_attempts'),
    count('assignment_submissions'),
  ]);
  return { students, assistants, courses, tests, attempts, submissions };
}

async function deleteSpace(res, actor, body) {
  const teacher = await getTeacher(body.teacher_id);

  // Typing the slug is the whole safety mechanism. An id in a request
  // body is easy to get wrong; a slug typed by hand is not something
  // that happens by accident.
  const typed = String(body.confirm_slug || '').trim().toLowerCase();
  if (typed !== teacher.slug.toLowerCase()) {
    throw new HttpError(400, `To delete this space, type its name exactly: ${teacher.slug}`);
  }

  const counts = await countTenant(teacher.id);

  // Deleting the teachers row cascades through the content, but NOT
  // through auth.users — those rows hang off profiles the other way
  // round. Left behind they would hold their email addresses forever,
  // so nobody in this space could ever be re-created, and each would
  // still carry app_metadata pointing at a tenant that no longer
  // exists. So the accounts go first.
  const { data: people, error: pErr } = await admin
    .from('profiles').select('id, full_name, role').eq('teacher_id', teacher.id);
  if (pErr) throw new HttpError(500, 'Could not list the accounts in that space.');

  const failed = [];
  // A space can hold 150 students, and a serverless function does not
  // have all day. Small batches keep it moving without opening 150
  // connections at once.
  for (let i = 0; i < people.length; i += 8) {
    const batch = people.slice(i, i + 8);
    const results = await Promise.allSettled(
      batch.map(p => admin.auth.admin.deleteUser(p.id).then(r => {
        if (r?.error) throw new Error(r.error.message);
      })));
    results.forEach((r, j) => { if (r.status === 'rejected') failed.push(batch[j].full_name); });
  }

  // Deleting accounts and deleting the space are two steps, so a run
  // that dies between them leaves the space standing with some accounts
  // gone. Re-running finishes the job rather than erroring, which is
  // why the accounts are removed first and the row last.
  if (failed.length) {
    throw new HttpError(500,
      `${failed.length} account${failed.length === 1 ? '' : 's'} could not be deleted (${failed.slice(0, 3).join(', ')}). Nothing else was removed — try again.`);
  }

  const { error: dErr } = await admin.from('teachers').delete().eq('id', teacher.id);
  if (dErr) throw new HttpError(500, 'The accounts were removed but the space itself was not. Please try again.');

  // teacher_id is null on purpose: a log line pointing at the deleted
  // space would cascade away with it, and this is the one event most
  // worth still having afterwards.
  await logActivity(null, actor,
    'space_deleted',
    `${teacher.display_name} (${teacher.slug}) — ${counts.students} students, ${counts.courses} courses, ${counts.attempts} results`);

  return res.status(200).json({ ok: true, deleted: counts, accounts_removed: people.length });
}

// ── Invoices ──────────────────────────────────────────────────────
async function addInvoice(res, actor, body) {
  const teacher = await getTeacher(body.teacher_id);
  const amount = Number(body.amount_egp);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter an amount in EGP.');
  const kind = ['setup', 'monthly', 'adjustment'].includes(body.kind) ? body.kind : 'monthly';

  const { data, error } = await admin.from('invoices').insert({
    teacher_id: teacher.id,
    kind,
    amount_egp: Math.round(amount),
    description: cleanText(body.description, { max: 200 }),
    period_start: body.period_start || null,
    period_end: body.period_end || null,
  }).select().single();
  if (error) throw new HttpError(500, 'Could not raise that invoice.');

  await logActivity(teacher.id, actor, 'invoice_raised', `${kind} · ${Math.round(amount)} EGP`);
  return res.status(200).json({ invoice: data });
}

async function markPaid(res, actor, body) {
  if (!body.invoice_id) throw new HttpError(400, 'No invoice was named.');
  const { data, error } = await admin.from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString(), reference: cleanText(body.reference, { max: 80 }) })
    .eq('id', body.invoice_id).select().single();
  if (error || !data) throw new HttpError(404, 'That invoice no longer exists.');

  await logActivity(data.teacher_id, actor, 'invoice_paid', `${data.kind} · ${data.amount_egp} EGP`);
  return res.status(200).json({ ok: true });
}

// ── Shared ────────────────────────────────────────────────────────
async function getTeacher(id) {
  if (!id) throw new HttpError(400, 'No teacher was named.');
  const { data, error } = await admin.from('teachers').select('*').eq('id', id).single();
  if (error || !data) throw new HttpError(404, 'That space no longer exists.');
  return data;
}

// The one account in a space that owns it. Assistants and students share
// the tenant but are not it, so the role filter is what makes this the
// teacher rather than whoever happens to come back first.
async function getTeacherProfile(teacherId) {
  const { data, error } = await admin
    .from('profiles').select('id, full_name, email, phone, role, teacher_id')
    .eq('teacher_id', teacherId).eq('role', 'teacher').maybeSingle();
  if (error) throw new HttpError(500, 'Could not load that teacher’s account.');
  return data || null;
}

async function getPlan(code) {
  const { data, error } = await admin.from('plans').select('*').eq('code', code).single();
  if (error || !data) throw new HttpError(400, 'That plan does not exist.');
  return data;
}

// Adding a month to the 31st lands on the 1st or 2nd of the month after —
// clamp to the end of the target month so a period never skips one.
function addMonth(date) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
