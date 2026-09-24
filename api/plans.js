import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, logActivity } from './_lib/auth.js';
import { cleanName, cleanText } from './_lib/util.js';

// The price list, editable.
//
// `plans` was always the source of truth — the marketing site reads it
// with the anon key, and setting a teacher's plan copies its numbers onto
// their subscription. What it had no way of being was *changed*: a price
// that had moved meant editing a seed file, so the site went on quoting
// last year's figure.
//
// Two things here are worth knowing before reading on.
//
// A subscription copies a plan's numbers at the moment it is set, and
// keeps them. That is deliberate — a teacher's agreed price should not
// move under them because the list price did. So repricing a plan is,
// by default, a change to what NEW teachers are quoted, and the response
// says how many existing teachers were left on the old figure.
// `apply_to_subscriptions` is how you move them too, and it is never the
// default.
//
// A plan code is a permanent handle: it is on every subscription, and on
// the ?plan= links people follow from the pricing page. It is set once
// when the plan is created and never edited afterwards. Getting rid of a
// plan means deactivating it, which takes it off the site while leaving
// every teacher on it exactly where they are.

const LISTINGS = new Set(['package', 'tier']);
const PACKAGES = new Set(['basic', 'full']);

export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  // Prices are Lumen's own business, not a teacher's: only the platform
  // owner reaches any of this.
  requireRoles(profile, ['owner']);

  const body = req.body || {};
  switch (body.action || 'save') {
    case 'save':      return savePlan(res, profile, body);
    case 'set_active':return setActive(res, profile, body);
    case 'reorder':   return reorder(res, body);
    case 'delete':    return deletePlan(res, profile, body);
    default: throw new HttpError(400, 'Unknown action.');
  }
});

// ── Create or change a plan ───────────────────────────────────────
async function savePlan(res, actor, body) {
  const code = cleanCode(body.code);
  const existing = await findPlan(code);

  const row = {
    code,
    name:            cleanName(body.name, 'Plan name'),
    listing:         pick(body.listing, LISTINGS, 'listing'),
    package:         pick(body.package, PACKAGES, 'package'),
    monthly_fee_egp: money(body.monthly_fee_egp, 'monthly fee'),
    setup_fee_egp:   money(body.setup_fee_egp, 'setup fee'),
    student_limit:   limit(body.student_limit),
    blurb:           cleanText(body.blurb, { max: 300 }),
    features:        features(body.features),
    sort_order:      Number.isInteger(body.sort_order) ? body.sort_order : (existing?.sort_order ?? 0),
    is_active:       body.is_active !== false,
  };

  const { error } = existing
    ? await admin.from('plans').update(row).eq('code', code)
    : await admin.from('plans').insert(row);
  if (error) throw new HttpError(500, 'Could not save that plan.');

  // Who is on this plan, and what a reprice means for them. The count is
  // taken after the write so the answer is about the plan as it now is.
  const { data: on } = await admin.from('subscriptions')
    .select('teacher_id, monthly_fee_egp, student_limit').eq('plan_code', code);
  const holders = on || [];

  let applied = 0;
  const repriced = !!existing && (
    existing.monthly_fee_egp !== row.monthly_fee_egp ||
    existing.student_limit !== row.student_limit ||
    existing.setup_fee_egp !== row.setup_fee_egp
  );

  if (body.apply_to_subscriptions && holders.length) {
    // Asked for explicitly, never assumed: this is the bill changing for
    // teachers who already agreed a figure.
    const { error: sErr } = await admin.from('subscriptions').update({
      monthly_fee_egp: row.monthly_fee_egp,
      setup_fee_egp:   row.setup_fee_egp,
      student_limit:   row.student_limit,
    }).eq('plan_code', code);
    if (sErr) throw new HttpError(500, 'The plan was saved but the teachers on it were not updated.');
    applied = holders.length;
    await logActivity(null, actor, 'plan_applied',
      `${row.name} · ${applied} subscription${applied === 1 ? '' : 's'} moved to ${row.monthly_fee_egp} EGP`);
  }

  await logActivity(null, actor, existing ? 'plan_updated' : 'plan_created',
    `${row.name} (${code}) · ${row.monthly_fee_egp} EGP · up to ${row.student_limit}`);

  return res.status(200).json({
    ok: true,
    created: !existing,
    // What the caller needs to say something true to the person: how many
    // teachers hold this plan, and whether any of them were left behind.
    holders: holders.length,
    applied,
    left_on_old_price: repriced && !body.apply_to_subscriptions ? holders.length : 0,
  });
}

// ── Take a plan off the site, or put it back ──────────────────────
// The kind way to retire a price: it stops being offered, and everybody
// already on it carries on untouched.
async function setActive(res, actor, body) {
  const plan = await requirePlan(body.code);
  const active = body.is_active !== false;

  const { error } = await admin.from('plans').update({ is_active: active }).eq('code', plan.code);
  if (error) throw new HttpError(500, 'Could not update that plan.');

  await logActivity(null, actor, active ? 'plan_activated' : 'plan_deactivated', plan.name);
  return res.status(200).json({ ok: true, is_active: active });
}

// ── The order they are listed in ──────────────────────────────────
async function reorder(res, body) {
  const codes = Array.isArray(body.codes) ? body.codes.filter(c => typeof c === 'string') : [];
  if (!codes.length) throw new HttpError(400, 'No order was given.');

  // Tens, so a plan can later be slipped between two without renumbering
  // the rest.
  for (let i = 0; i < codes.length; i++) {
    const { error } = await admin.from('plans').update({ sort_order: (i + 1) * 10 }).eq('code', codes[i]);
    if (error) throw new HttpError(500, 'Could not save that order.');
  }
  return res.status(200).json({ ok: true });
}

// ── Delete ────────────────────────────────────────────────────────
async function deletePlan(res, actor, body) {
  const plan = await requirePlan(body.code);

  // A plan on a live subscription is the record of what that teacher
  // agreed to. Deleting it would either fail on the foreign key or blank
  // the reference; deactivating does what was actually wanted.
  const { data: on } = await admin.from('subscriptions').select('teacher_id').eq('plan_code', plan.code).limit(1);
  if (on?.length) {
    throw new HttpError(409, 'Teachers are on this plan, so it cannot be deleted. Turn it off instead — it comes off the website and they stay exactly as they are.');
  }

  const { error } = await admin.from('plans').delete().eq('code', plan.code);
  if (error) throw new HttpError(500, 'Could not delete that plan.');

  await logActivity(null, actor, 'plan_deleted', `${plan.name} (${plan.code})`);
  return res.status(200).json({ ok: true });
}

// ── Shared ────────────────────────────────────────────────────────
async function findPlan(code) {
  const { data } = await admin.from('plans').select('*').eq('code', code).maybeSingle();
  return data || null;
}

async function requirePlan(code) {
  const plan = await findPlan(cleanCode(code));
  if (!plan) throw new HttpError(404, 'That plan no longer exists.');
  return plan;
}

// The code goes in URLs and on every subscription, so it is narrow on
// purpose and never changes once a plan exists.
function cleanCode(value) {
  const code = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (code.length < 2) throw new HttpError(400, 'Give the plan a short code, like "tier-60".');
  if (code.length > 40) throw new HttpError(400, 'That plan code is too long.');
  return code;
}

function pick(value, allowed, what) {
  const v = String(value || '').trim();
  if (!allowed.has(v)) throw new HttpError(400, `Choose a ${what} for this plan.`);
  return v;
}

// Whole pounds. A price of 5999.5 is a typing slip, not a price.
function money(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
    throw new HttpError(400, `That ${what} is not a sensible amount.`);
  }
  return n;
}

function limit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new HttpError(400, 'That student limit is not sensible.');
  }
  return n;
}

// The bullet list on a price card. Blank lines are dropped rather than
// printed as empty bullets.
function features(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split('\n');
  return list.map(f => String(f).trim()).filter(Boolean).slice(0, 20).map(f => f.slice(0, 160));
}
