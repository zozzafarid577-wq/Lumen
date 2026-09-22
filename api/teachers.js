import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, logActivity } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanSlug, cleanText, generatePassword, findUserByEmail } from './_lib/util.js';
import { sendEmail, teacherWelcome, loginUrlFor } from './_lib/email.js';

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
    case 'set_plan':      return setPlan(res, profile, body);
    case 'set_active':    return setActive(res, profile, body);
    case 'add_invoice':   return addInvoice(res, profile, body);
    case 'mark_paid':     return markPaid(res, profile, body);
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
