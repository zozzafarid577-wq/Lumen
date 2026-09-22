import { admin } from './supabase.js';
import { HttpError } from './auth.js';

// Statuses that still entitle a teacher to add students. `past_due` does
// not: a plan that is not being paid for should not keep growing. Their
// existing students keep working throughout — nothing is ever cut off for
// the class because of the teacher's invoice.
const ADDING_ALLOWED = new Set(['trial', 'active']);

export async function getSubscription(teacherId) {
  const { data } = await admin.from('subscriptions').select('*').eq('teacher_id', teacherId).single();
  return data || null;
}

export async function countStudents(teacherId) {
  const { count } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('teacher_id', teacherId)
    .eq('role', 'student')
    .eq('is_active', true);
  return count || 0;
}

export async function allowance(teacherId) {
  const sub = await getSubscription(teacherId);
  const used = await countStudents(teacherId);
  return {
    used,
    allowed: sub?.student_limit ?? 0,
    status: sub?.status ?? 'none',
    left: Math.max(0, (sub?.student_limit ?? 0) - used),
  };
}

// Called before creating a student, and before reactivating one — both
// take up a place on the plan. The message says the number, because "plan
// limit reached" leaves the teacher guessing what to buy.
export async function assertCanAddStudent(teacherId) {
  const { used, allowed, status } = await allowance(teacherId);

  if (status === 'none') {
    throw new HttpError(402, 'This space has no subscription yet. Please contact Lumen to set one up.');
  }
  if (!ADDING_ALLOWED.has(status)) {
    throw new HttpError(402, status === 'past_due'
      ? 'Your subscription is past due, so new student accounts are paused. Settle the latest invoice to continue — your current students are unaffected.'
      : 'Your subscription is not active, so new student accounts are paused. Your existing content and students are unaffected.');
  }
  if (used >= allowed) {
    throw new HttpError(402,
      `Your plan covers ${allowed} students and all ${allowed} places are in use. Contact Lumen to move up a tier.`);
  }
  return { used, allowed, left: allowed - used };
}

// A trial gets a small allowance so a teacher can set up and try the
// portal with a handful of real students before committing to a tier.
export const TRIAL_STUDENT_LIMIT = 10;
export const TRIAL_DAYS = 14;
