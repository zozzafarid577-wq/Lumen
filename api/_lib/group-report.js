import ExcelJS from 'exceljs';
import { admin } from './supabase.js';
import { sendEmail } from './email.js';

// The morning before a group meets, its teacher gets the group's marks.
//
// Run once a day by the Vercel cron (GET /api/health?task=group-report),
// early in the Egyptian morning. For every group with a session tomorrow
// it gathers what each of its students has done since the group last met
// — tests on Lumen and marks typed in for papers done in class — and
// emails the teacher an Excel sheet: one row per student, one column per
// test. A student who did nothing is still a row; that is often the line
// the teacher most needs to see.
//
// notify_log holds one key per group and date, so a second run on the
// same morning sends nothing.

const TZ = 'Africa/Cairo';
const DAY_MS = 86400000;
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Cairo's calendar date and weekday for an instant.
export function cairoDay(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(at).map(p => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, dow };
}

// The instant Cairo's day `iso` began. Egypt moves its clocks, so the
// offset is read for that date rather than assumed.
function cairoMidnight(iso) {
  const guess = new Date(`${iso}T00:00:00Z`);
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (shown - utc));
}

function addDays(iso, n) {
  return new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

// How many days back the group last met before `dow`, 1–7. A group that
// meets once a week gets the whole week.
export function daysSinceLastSession(days, dow) {
  for (let k = 1; k <= 7; k++) if (days.includes((dow - k + 7) % 7)) return k;
  return 7;
}

const mark = (a) => `${a.score ?? 0}/${a.max_score ?? 0}`;

export async function runGroupReports(now = new Date()) {
  const today = cairoDay(now);
  const tomorrowIso = addDays(today.iso, 1);
  const tomorrowDow = (today.dow + 1) % 7;

  const { data: groups } = await admin.from('groups')
    .select('id, name, days, start_time, course_id, teacher_id, courses(title)');
  const due = (groups || []).filter(g => (g.days || []).includes(tomorrowDow));
  let sent = 0;

  for (const g of due) {
    const key = `group-report:${g.id}:${tomorrowIso}`;
    const { error: dupe } = await admin.from('notify_log').insert({ key });
    if (dupe) continue;                                   // already sent this morning

    try {
      const back = daysSinceLastSession(g.days, tomorrowDow);
      const from = cairoMidnight(addDays(tomorrowIso, -back));
      const report = await buildReport(g, from, now);
      const to = await recipients(g.teacher_id);
      if (!to.length) continue;

      const when = `${DAY_NAME[tomorrowDow]}${g.start_time ? ' at ' + g.start_time.slice(0, 5) : ''}`;
      const subject = `${g.name} (${g.courses?.title || 'course'}) — marks before ${when}`;
      for (const r of to) {
        const out = await sendEmail({
          to: r.email, toName: r.name, subject,
          html: reportEmail({ group: g, when, from, report }),
          attachments: [{ name: report.fileName, content: report.base64 }],
        });
        if (out.sent) sent++;
        else console.error('group report not sent:', r.email, out.error);
      }
    } catch (err) {
      console.error('group report failed for', g.id, err);
      await admin.from('notify_log').delete().eq('key', key);   // so a rerun can try again
    }
  }
  return { groups: due.length, sent };
}

async function recipients(teacherId) {
  const { data } = await admin.from('profiles').select('full_name, email')
    .eq('teacher_id', teacherId).eq('role', 'teacher').eq('is_active', true);
  let out = (data || []).filter(p => p.email).map(p => ({ email: p.email, name: p.full_name }));
  if (!out.length) {
    const { data: t } = await admin.from('teachers').select('contact_email, display_name').eq('id', teacherId).single();
    if (t?.contact_email) out = [{ email: t.contact_email, name: t.display_name }];
  }
  return out;
}

export async function buildReport(group, from, until = new Date()) {
  const { data: enrol } = await admin.from('enrollments')
    .select('student_id, profiles(full_name, phone, is_active)')
    .eq('course_id', group.course_id).eq('group_id', group.id);
  const students = (enrol || [])
    .filter(e => e.profiles && e.profiles.is_active !== false)
    .map(e => ({ id: e.student_id, name: e.profiles.full_name, phone: e.profiles.phone || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let attempts = [];
  if (students.length) {
    const { data } = await admin.from('test_attempts')
      .select('student_id, test_id, score, max_score, percentage, passed, completed_at, practice_tests(title, course_id, is_offline, test_sections(name))')
      .in('student_id', students.map(s => s.id))
      .gte('completed_at', from.toISOString()).lte('completed_at', until.toISOString())
      .order('completed_at');
    attempts = (data || []).filter(a => a.practice_tests?.course_id === group.course_id);
  }

  // One column per test, in the order they were first done; each cell is
  // the student's best mark on it in this window.
  const tests = [];
  const best = new Map();                                  // `${student}|${test}` -> attempt
  for (const a of attempts) {
    if (!tests.some(t => t.id === a.test_id)) {
      const t = a.practice_tests;
      const section = t.test_sections?.name;
      tests.push({ id: a.test_id, title: t.title + (section ? ` (${section})` : '') + (t.is_offline ? ' — in class' : '') });
    }
    const k = `${a.student_id}|${a.test_id}`;
    const cur = best.get(k);
    if (!cur || Number(a.percentage) > Number(cur.percentage)) best.set(k, a);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lumen';
  const ws = wb.addWorksheet('Marks', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.columns = [
    { header: 'Student', width: 28 },
    ...tests.map(t => ({ header: t.title, width: Math.min(40, Math.max(14, t.title.length + 2)) })),
    { header: 'Tests done', width: 12 },
  ];
  const nobody = [];
  for (const s of students) {
    const cells = tests.map(t => { const a = best.get(`${s.id}|${t.id}`); return a ? mark(a) : '—'; });
    const done = cells.filter(c => c !== '—').length;
    if (!done) nobody.push(s.name);
    const row = ws.addRow([s.name, ...cells, done]);
    tests.forEach((t, i) => {
      const a = best.get(`${s.id}|${t.id}`);
      if (a) row.getCell(i + 2).font = { color: { argb: a.passed ? 'FF1F7A4D' : 'FFB42318' } };
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { wrapText: true, vertical: 'middle' };

  // Every attempt as its own line, for anyone who wants to sort or filter.
  const all = wb.addWorksheet('Every attempt');
  all.columns = [
    { header: 'Student', width: 28 }, { header: 'Test', width: 40 }, { header: 'Mark', width: 10 },
    { header: 'Out of', width: 8 }, { header: '%', width: 7 }, { header: 'Passed', width: 8 }, { header: 'Date', width: 18 },
  ];
  const nameOf = new Map(students.map(s => [s.id, s.name]));
  for (const a of attempts) {
    all.addRow([nameOf.get(a.student_id), tests.find(t => t.id === a.test_id)?.title, a.score, a.max_score,
      Math.round(Number(a.percentage) || 0), a.passed ? 'Yes' : 'No',
      new Date(a.completed_at).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' })]);
  }
  all.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  const safe = `${group.name}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'group';
  return {
    students: students.length, tests: tests.length, attempts: attempts.length, nobody,
    fileName: `${safe}-marks-${cairoDay(until).iso}.xlsx`,
    base64: Buffer.from(buf).toString('base64'),
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function reportEmail({ group, when, from, report }) {
  const since = from.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const missing = report.nobody.length
    ? `<p style="margin:14px 0 6px"><strong>Nothing done since ${esc(since)} (${report.nobody.length}):</strong></p>
       <p style="margin:0;color:#554C53">${report.nobody.map(esc).join(', ')}</p>`
    : '<p style="margin:14px 0 0">Every student did at least one test.</p>';
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1B1519;line-height:1.5;max-width:560px">
    <p style="margin:0 0 10px">Your <strong>${esc(group.name)}</strong> group (${esc(group.courses?.title || '')}) meets <strong>${esc(when)}</strong>.</p>
    <p style="margin:0">Since ${esc(since)}: <strong>${report.students}</strong> students, <strong>${report.tests}</strong> tests, <strong>${report.attempts}</strong> attempts.</p>
    ${missing}
    <p style="margin:18px 0 0">The full sheet is attached — one row per student, one column per test, with each student's best mark.</p>
    <p style="margin:18px 0 0;color:#8B8089;font-size:13px">Sent by Lumen the morning before each group session.</p>
  </div>`;
}

// A trial run for checking the email and the sheet: the real report for
// this teacher's groups, sent only to Lumen's own inbox, marked TEST, and
// not recorded — so the real morning email still goes out as usual.
// The groups that meet tomorrow, or else the next one to meet.
export async function runGroupReportTest(teacherId, inbox, now = new Date()) {
  const today = cairoDay(now);
  const { data: groups } = await admin.from('groups')
    .select('id, name, days, start_time, course_id, teacher_id, courses(title)').eq('teacher_id', teacherId);
  const withDays = (groups || []).filter(g => (g.days || []).length);
  let pick = [], ahead = 1;
  for (; ahead <= 7 && !pick.length; ahead++) {
    const dow = (today.dow + ahead) % 7;
    pick = withDays.filter(g => g.days.includes(dow));
  }
  ahead--;
  const sentFor = [];
  for (const g of pick) {
    const dayIso = addDays(today.iso, ahead);
    const dow = (today.dow + ahead) % 7;
    const back = daysSinceLastSession(g.days, dow);
    const from = cairoMidnight(addDays(dayIso, -back));
    const report = await buildReport(g, from, now);
    const when = `${DAY_NAME[dow]}${g.start_time ? ' at ' + g.start_time.slice(0, 5) : ''}`;
    const out = await sendEmail({
      to: inbox, toName: 'Lumen',
      subject: `[TEST] ${g.name} (${g.courses?.title || 'course'}) — marks before ${when}`,
      html: reportEmail({ group: g, when, from, report }),
      attachments: [{ name: report.fileName, content: report.base64 }],
    });
    sentFor.push({ group: g.name, when, students: report.students, tests: report.tests, sent: out.sent, error: out.error || null });
  }
  return { to: inbox, groups: sentFor };
}

// "Send now" from the Groups list: the same email, straight away, to the
// teacher. It covers everything since the group's last session before
// today, and is not recorded, so the morning email still goes out too.
export async function sendGroupReportNow(groupId, teacherId, now = new Date()) {
  const { data: g } = await admin.from('groups')
    .select('id, name, days, start_time, course_id, teacher_id, courses(title)').eq('id', groupId).single();
  if (!g || g.teacher_id !== teacherId) return { error: 'That group was not found.' };
  const today = cairoDay(now);
  const back = (g.days || []).length ? daysSinceLastSession(g.days, today.dow) : 7;
  const from = cairoMidnight(addDays(today.iso, -back));
  const report = await buildReport(g, from, now);
  const to = await recipients(teacherId);
  if (!to.length) return { error: 'There is no teacher email address to send it to.' };
  const when = (g.days || []).length
    ? g.days.map(d => DAY_NAME[d]).join(' & ') + (g.start_time ? ' at ' + g.start_time.slice(0, 5) : '')
    : 'its next session';
  const sent = [];
  for (const r of to) {
    const out = await sendEmail({
      to: r.email, toName: r.name,
      subject: `${g.name} (${g.courses?.title || 'course'}) — marks so far`,
      html: reportEmail({ group: g, when, from, report }),
      attachments: [{ name: report.fileName, content: report.base64 }],
    });
    sent.push({ to: r.email, sent: out.sent, error: out.error || null });
  }
  return { group: g.name, students: report.students, tests: report.tests, sent };
}
