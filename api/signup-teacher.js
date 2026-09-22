import { admin } from './_lib/supabase.js';
import { handler, HttpError } from './_lib/auth.js';
import { cleanEmail, cleanName, cleanSlug, cleanText, findUserByEmail } from './_lib/util.js';
import { TRIAL_DAYS, TRIAL_STUDENT_LIMIT } from './_lib/subscription.js';

// Public: a teacher starts their own Lumen space on a free trial.
//
// This is the one endpoint with no caller to authenticate, so it creates
// exactly one thing — a brand-new tenant with a brand-new owner — and
// never touches anything that already exists.
//
// Three rows have to land together: the teacher (tenant), the auth user,
// and the profile that ties them. A half-made space is worse than no
// space, so each step undoes the ones before it if it fails.
export default handler(async (req, res) => {
  const body = req.body || {};

  const fullName = cleanName(body.full_name, 'Your name');
  const email    = cleanEmail(body.email);
  const password = String(body.password || '');
  const subject  = cleanText(body.subject, { max: 80 });
  const phone    = cleanText(body.phone, { max: 40 });
  const spaceName = cleanName(body.display_name || fullName, 'Space name');
  const slug     = cleanSlug(body.slug || spaceName);

  if (password.length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters.');

  // Say plainly that the address is taken rather than failing at the auth
  // call with wording no teacher can act on.
  if (await findUserByEmail(admin, email)) {
    throw new HttpError(409, 'An account already exists for that email. Try signing in instead.');
  }

  const { data: existingSlug } = await admin.from('teachers').select('id').eq('slug', slug).maybeSingle();
  if (existingSlug) throw new HttpError(409, 'That space name is already taken. Please choose another.');

  const { data: teacher, error: tErr } = await admin.from('teachers').insert({
    slug,
    display_name: spaceName,
    subject,
    contact_email: email,
    contact_phone: phone,
  }).select().single();
  if (tErr) throw new HttpError(500, 'Could not create your space. Please try again.');

  let userId = null;
  try {
    // The claims below are what row-level security reads. They are set
    // here, by the service role, and there is no path by which the signed-in
    // user can change them afterwards.
    const { data: created, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: 'teacher', teacher_id: teacher.id },
      user_metadata: { full_name: fullName },
    });
    if (uErr || !created?.user) throw new HttpError(400, uErr?.message || 'Could not create your account.');
    userId = created.user.id;

    const { error: pErr } = await admin.from('profiles').insert({
      id: userId,
      teacher_id: teacher.id,
      role: 'teacher',
      full_name: fullName,
      email,
      phone,
      // They chose this password themselves, so there is nobody else to
      // change it away from.
      must_change_pw: false,
    });
    if (pErr) throw new HttpError(500, 'Could not finish setting up your account.');

    const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400000);
    await admin.from('subscriptions').insert({
      teacher_id: teacher.id,
      status: 'trial',
      student_limit: TRIAL_STUDENT_LIMIT,
      monthly_fee_egp: 0,
      trial_ends_at: trialEnds.toISOString(),
      current_period_start: new Date().toISOString(),
      current_period_end: trialEnds.toISOString(),
      notes: 'Self-serve trial',
    });

    return res.status(200).json({
      teacher_id: teacher.id,
      slug,
      trial_ends_at: trialEnds.toISOString(),
      student_limit: TRIAL_STUDENT_LIMIT,
    });
  } catch (err) {
    // Roll back, newest first, so a failed signup leaves nothing behind
    // and the teacher can simply try again with the same email.
    if (userId) { try { await admin.auth.admin.deleteUser(userId); } catch (_) {} }
    try { await admin.from('teachers').delete().eq('id', teacher.id); } catch (_) {}
    throw err;
  }
});
