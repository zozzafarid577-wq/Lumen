import { admin } from './supabase.js';
import { sendEmail, dailyEvaluation, weeklyReport } from './email.js';
import { logActivity } from './auth.js';
import { cairoDay, cairoMidnight, addDays } from './group-report.js';

// Reports that go to parents on their own, without the teacher pressing
// anything. Each teacher turns them on in Settings (teachers.parent_reports,
// supabase-migration-v24.sql); nobody gets one until they do.
//
//   daily   the morning after a day with something in it: the tests their
//           child finished, the lessons they watched, and any homework that
//           fell due and was not handed in. A quiet day sends nothing — a
//           parent who gets an email every morning stops opening them.
//   weekly  once a week, on the teacher's day: the week in numbers, and
//           every unit the child has been tested on sorted into strong,
//           getting there and needs work, with the weakest named as next
//           week's focus. A unit's mark is the average of the child's BEST
//           attempt on each of its tests — the same rule the portals score
//           by, so one bad first try is never the story a parent is told.
//
// notify_log keeps each to once per child per day or week. The weekly key
// is the start of the teacher's week, so a run that ran out of time sends
// the rest the next morning instead of losing them.

const PAGE = 1000;
// The morning run is one serverless call with a 60-second limit, shared
// with the other morning emails. Past this, no new report is started.
const BUDGET_MS = 40000;
const AT_ONCE = 8;

export const STRONG = 75;
export const NEEDS_WORK = 60;

export function levelFor(pct) {
  if (pct >= STRONG) return 'strong';
  if (pct >= NEEDS_WORK) return 'getting';
  return 'weak';
}

export function settingsOf(teacher) {
  const s = teacher?.parent_reports || {};
  const day = Number.isInteger(s.weekly_day) && s.weekly_day >= 0 && s.weekly_day <= 6 ? s.weekly_day : 6;
  return { daily: s.daily === true, weekly: s.weekly === true, weeklyDay: day };
}

// The first day of the teacher's report week that `today` falls in.
export function weekStart(today, weeklyDay) {
  return addDays(today.iso, -((today.dow - weeklyDay + 7) % 7));
}

async function everyRow(makeQuery) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

const pct = (a) => {
  const p = parseFloat(a.percentage);
  return Number.isNaN(p) ? null : p;
};

// Units the child has been tested on, each with its average of best marks.
export function unitBreakdown(attempts, tests, modules) {
  const best = new Map();
  for (const a of attempts) {
    const p = pct(a);
    if (p == null) continue;
    if (!best.has(a.test_id) || p > best.get(a.test_id)) best.set(a.test_id, p);
  }
  const byUnit = new Map();
  for (const [testId, p] of best) {
    const unitId = tests.get(testId)?.module_id;
    if (!unitId || !modules.has(unitId)) continue;
    if (!byUnit.has(unitId)) byUnit.set(unitId, []);
    byUnit.get(unitId).push(p);
  }
  return [...byUnit.entries()].map(([id, list]) => {
    const m = modules.get(id);
    const avg = Math.round(list.reduce((t, x) => t + x, 0) / list.length);
    return { title: m.title, order: m.order_index ?? 0, pct: avg, tests: list.length, level: levelFor(avg) };
  }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

async function loadSpace(teacherId, since) {
  const [students, enrolments, tests, modules, attempts, lessons, homework, space] = await Promise.all([
    everyRow(() => admin.from('profiles').select('id, full_name, parent_email')
      .eq('teacher_id', teacherId).eq('role', 'student').eq('is_active', true)
      .not('parent_email', 'is', null).order('id')),
    everyRow(() => admin.from('enrollments').select('student_id, course_id').eq('teacher_id', teacherId).order('student_id')),
    everyRow(() => admin.from('practice_tests').select('id, title, module_id').eq('teacher_id', teacherId).order('id')),
    everyRow(() => admin.from('modules').select('id, title, order_index').eq('teacher_id', teacherId).order('id')),
    everyRow(() => admin.from('test_attempts')
      .select('student_id, test_id, score, max_score, percentage, passed, completed_at')
      .eq('teacher_id', teacherId).not('completed_at', 'is', null).order('id')),
    everyRow(() => admin.from('lesson_completions').select('student_id, completed_at')
      .eq('teacher_id', teacherId).gte('completed_at', since.toISOString()).order('student_id')),
    everyRow(() => admin.from('assignments').select('id, title, course_id, due_at')
      .eq('teacher_id', teacherId).eq('is_active', true)
      .gte('due_at', since.toISOString()).order('id')),
    admin.from('teachers').select('display_name, contact_email').eq('id', teacherId).maybeSingle(),
  ]);
  const ids = homework.map(h => h.id);
  const handedIn = ids.length
    ? await everyRow(() => admin.from('assignment_submissions').select('assignment_id, student_id')
      .eq('teacher_id', teacherId).in('assignment_id', ids).order('assignment_id'))
    : [];
  return {
    students,
    courses: groupSet(enrolments, 'student_id', 'course_id'),
    tests: new Map(tests.map(t => [t.id, t])),
    modules: new Map(modules.map(m => [m.id, m])),
    attempts: groupList(attempts, 'student_id'),
    lessons: groupList(lessons, 'student_id'),
    homework,
    handedIn: new Set(handedIn.map(h => `${h.assignment_id}:${h.student_id}`)),
    spaceName: space.data?.display_name || null,
    teacherEmail: space.data?.contact_email || null,
  };
}

function groupList(rows, key) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }
  return m;
}
function groupSet(rows, key, value) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r[key])) m.set(r[key], new Set()); m.get(r[key]).add(r[value]); }
  return m;
}

const within = (iso, from, until) => { const t = new Date(iso).getTime(); return t >= from.getTime() && t < until.getTime(); };

// What one child did in [from, until).
export function periodFor(space, student, from, until) {
  const attempts = (space.attempts.get(student.id) || []).filter(a => within(a.completed_at, from, until))
    .sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at));
  const lessons = (space.lessons.get(student.id) || []).filter(l => within(l.completed_at, from, until)).length;
  const mine = space.courses.get(student.id) || new Set();
  const due = space.homework.filter(h => mine.has(h.course_id) && within(h.due_at, from, until));
  const missed = due.filter(h => !space.handedIn.has(`${h.id}:${student.id}`));
  return {
    tests: attempts.map(a => ({
      title: space.tests.get(a.test_id)?.title || 'A test',
      score: a.score, maxScore: a.max_score, passed: !!a.passed, pct: pct(a),
    })),
    lessons,
    homeworkDue: due.length,
    homeworkDone: due.length - missed.length,
    missed: missed.map(h => h.title),
  };
}

const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

// Runs `jobs` a few at a time, stopping new ones once the budget is spent.
async function inBatches(jobs, startedAt) {
  const results = [];
  let skipped = 0;
  for (let i = 0; i < jobs.length; i += AT_ONCE) {
    if (Date.now() - startedAt > BUDGET_MS) { skipped = jobs.length - i; break; }
    results.push(...await Promise.all(jobs.slice(i, i + AT_ONCE).map(job => job())));
  }
  return { results, skipped };
}

// The morning run. `to` sends every report to that one inbox, marked
// [TEST], for the first few students only, and records nothing.
export async function runParentReports(now = new Date(), { onlyTeacher = null, to = null, sample = 3 } = {}) {
  const startedAt = Date.now();
  const today = cairoDay(now);
  const yesterday = addDays(today.iso, -1);

  let q = admin.from('teachers').select('id, parent_reports').eq('is_active', true);
  if (onlyTeacher) q = q.eq('id', onlyTeacher);
  const { data: teachers, error } = await q;
  if (error) throw new Error(error.message);

  const out = [];
  for (const teacher of teachers || []) {
    const s = settingsOf(teacher);
    // A trial shows both, whatever is switched on.
    const wantDaily = to ? true : s.daily;
    const wantWeekly = to ? true : s.weekly;
    if (!wantDaily && !wantWeekly) continue;

    // The week reported on is the seven days before this report week began
    // (or, for a trial, the seven days before today).
    const weekIso = weekStart(today, s.weeklyDay);
    const lastDay = to ? today.iso : weekIso;
    const weekDays = [addDays(lastDay, -7), addDays(lastDay, -1)];
    const weekFrom = cairoMidnight(weekDays[0]);
    const weekUntil = cairoMidnight(lastDay);
    const dayFrom = cairoMidnight(yesterday), dayUntil = cairoMidnight(today.iso);

    try {
      const space = await loadSpace(teacher.id, new Date(Math.min(weekFrom.getTime(), dayFrom.getTime())));
      const students = to ? space.students.slice(0, sample) : space.students;
      const jobs = [];
      for (const student of students) {
        if (wantDaily) jobs.push(() => sendDaily(space, student, { yesterday, dayFrom, dayUntil, to }));
        if (wantWeekly) jobs.push(() => sendWeekly(space, student, { weekIso, weekDays, weekFrom, weekUntil, to }));
      }
      const { results, skipped } = await inBatches(jobs, startedAt);
      const sent = results.filter(r => r.sent);
      if (!to && sent.length) {
        const daily = sent.filter(r => r.kind === 'daily').length, weekly = sent.filter(r => r.kind === 'weekly').length;
        await logActivity(teacher.id, null, 'parent_reports_sent',
          [daily && `${daily} daily`, weekly && `${weekly} weekly`].filter(Boolean).join(' · '));
      }
      out.push({ teacherId: teacher.id, sent: sent.length, quiet: results.filter(r => r.quiet).length,
        failed: results.filter(r => r.error).length, skipped, ...(to ? { results } : {}) });
    } catch (err) {
      console.error('parent reports failed for', teacher.id, err);
      out.push({ teacherId: teacher.id, error: err.message });
    }
  }
  return { day: today.iso, teachers: out };
}

// Claims the key first, so two runs never both send; gives it back if
// the email did not go, so the next run can try again.
async function once(key, to, send) {
  if (!to) {
    const { error } = await admin.from('notify_log').insert({ key });
    if (error) return { already: true };
  }
  const res = await send();
  if (!to && !res.sent) await admin.from('notify_log').delete().eq('key', key);
  return res;
}

async function sendDaily(space, student, { yesterday, dayFrom, dayUntil, to }) {
  const day = periodFor(space, student, dayFrom, dayUntil);
  if (!day.tests.length && !day.lessons && !day.missed.length) return { kind: 'daily', quiet: true };
  const mail = dailyEvaluation({
    studentName: student.full_name, spaceName: space.spaceName, teacherEmail: space.teacherEmail,
    dayLabel: dayLabel(yesterday), ...day,
  });
  const res = await once(`parent-daily:${student.id}:${yesterday}`, to, () => sendEmail({
    to: to || student.parent_email, subject: `${to ? '[TEST] ' : ''}${mail.subject}`, html: mail.html, pdf: false, replyTo: space.teacherEmail || undefined,
  }));
  return { kind: 'daily', student: student.full_name, sent: !!res.sent, already: !!res.already, error: res.error || null };
}

async function sendWeekly(space, student, { weekIso, weekDays, weekFrom, weekUntil, to }) {
  const all = space.attempts.get(student.id) || [];
  const week = periodFor(space, student, weekFrom, weekUntil);
  // Nothing ever sat and nothing due this week: there is nothing to say yet.
  if (!all.length && !week.homeworkDue && !week.lessons) return { kind: 'weekly', quiet: true };
  const units = unitBreakdown(all, space.tests, space.modules);
  const marks = week.tests.filter(t => t.pct != null);
  const mail = weeklyReport({
    studentName: student.full_name, spaceName: space.spaceName, teacherEmail: space.teacherEmail,
    weekLabel: `${dayLabel(weekDays[0])} – ${dayLabel(weekDays[1])}`,
    week: {
      tests: week.tests.length,
      average: marks.length ? Math.round(marks.reduce((t, x) => t + x.pct, 0) / marks.length) : null,
      lessons: week.lessons, homeworkDue: week.homeworkDue, homeworkDone: week.homeworkDone, missed: week.missed,
    },
    units,
  });
  const res = await once(`parent-weekly:${student.id}:${weekIso}`, to, () => sendEmail({
    to: to || student.parent_email, subject: `${to ? '[TEST] ' : ''}${mail.subject}`, html: mail.html, pdf: false, replyTo: space.teacherEmail || undefined,
  }));
  return { kind: 'weekly', student: student.full_name, sent: !!res.sent, already: !!res.already, error: res.error || null };
}
