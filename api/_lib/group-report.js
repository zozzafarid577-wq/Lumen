import ExcelJS from 'exceljs';
import { admin } from './supabase.js';
import { sendEmail, teacherReport, reportBits } from './email.js';
import { logActivity } from './auth.js';

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
export function cairoMidnight(iso) {
  const guess = new Date(`${iso}T00:00:00Z`);
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (shown - utc));
}

export function addDays(iso, n) {
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
    .select('*, courses(title)');
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
      const to = await recipients(g);
      if (!to.length) { await admin.from('notify_log').delete().eq('key', key); continue; }

      const when = `${DAY_NAME[tomorrowDow]}${g.start_time ? ' at ' + g.start_time.slice(0, 5) : ''}`;
      const subject = `${g.name} (${g.courses?.title || 'course'}) — marks before ${when}`;
      const ok = [];
      for (const r of to) {
        const out = await sendEmail({
          to: r.email, toName: r.name, subject,
          html: reportEmail({ group: g, when, from, report }),
          attachments: [{ name: report.fileName, content: report.base64 }],
        });
        if (out.sent) { sent++; ok.push(r.email); }
        else console.error('group report not sent:', r.email, out.error);
      }
      // Nothing went: forget it was tried, so the next run tries again.
      if (!ok.length) await admin.from('notify_log').delete().eq('key', key);
      else await logActivity(g.teacher_id, null, 'group_report_sent', `${g.name} → ${ok.join(', ')}`);
    } catch (err) {
      console.error('group report failed for', g.id, err);
      await admin.from('notify_log').delete().eq('key', key);   // so a rerun can try again
    }
  }
  return { groups: due.length, sent };
}

// Everyone on the space's report list, plus any address only this group
// carries — so a group saved before an assistant was added still reaches
// them.
async function recipients(group) {
  return mergeRecipients(emailList(group), await reportRecipients(group.teacher_id));
}

// teacher_email holds the teacher's address and then any assistants',
// comma-separated (set under Students → Groups). The name is the teacher's.
function emailList(row) {
  return String(row.teacher_email || '').split(',').map(x => x.trim()).filter(Boolean)
    .map((email, i) => ({ email, name: i === 0 ? row.teacher_name || undefined : undefined }));
}

// One entry per address, first one kept (it carries the name).
function mergeRecipients(...lists) {
  const seen = new Set();
  return lists.flat().filter(r => {
    const k = r.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Where a teacher's emails go: the address list set once under Students →
// Groups (kept on every group row; every row is read, not just one), or
// the teacher account when none is set — and every active assistant
// ticked for "Emails" on the Team page, so whatever the teacher gets,
// they get too.
export async function reportRecipients(teacherId) {
  const { data: g } = await admin.from('groups').select('teacher_name, teacher_email')
    .eq('teacher_id', teacherId).not('teacher_email', 'is', null);
  const listed = mergeRecipients(...(g || []).map(emailList));
  const teacher = listed.length ? listed : await accountRecipients(teacherId);
  return mergeRecipients(teacher, await assistantRecipients(teacherId));
}

async function assistantRecipients(teacherId) {
  const { data } = await admin.from('profiles').select('full_name, email')
    .eq('teacher_id', teacherId).eq('role', 'assistant').eq('is_active', true)
    .contains('staff_perms', ['emails']);
  return (data || []).filter(p => p.email).map(p => ({ email: p.email.trim(), name: p.full_name }));
}

async function accountRecipients(teacherId) {
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
      .select('student_id, test_id, score, max_score, percentage, passed, completed_at, practice_tests(title, course_id, is_offline, test_sections(name), lessons(title))')
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
      tests.push({ id: a.test_id, title: testLabel(a.practice_tests) });
    }
    const k = `${a.student_id}|${a.test_id}`;
    const cur = best.get(k);
    if (!cur || Number(a.percentage) > Number(cur.percentage)) best.set(k, a);
  }

  const homework = await homeworkFor(group, students, from, until);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lumen';
  const ws = wb.addWorksheet('Marks', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.columns = [
    { header: 'Student', width: 28 },
    ...tests.map(t => ({ header: t.title, width: Math.min(40, Math.max(14, t.title.length + 2)) })),
    { header: 'Tests done', width: 12 },
  ];
  const nobody = [];
  const perStudent = [];
  for (const s of students) {
    const cells = tests.map(t => { const a = best.get(`${s.id}|${t.id}`); return a ? mark(a) : '—'; });
    const done = cells.filter(c => c !== '—').length;
    if (!done) nobody.push(s.name);
    perStudent.push({ name: s.name, done, marks: tests.map(t => best.get(`${s.id}|${t.id}`)).filter(Boolean)
      .map(a => ({ title: tests.find(t => t.id === a.test_id)?.title, mark: mark(a), passed: a.passed })) });
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

  // Homework: every student, every test set to the group, done or not.
  if (homework.length) {
    const hw = wb.addWorksheet('Homework', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
    hw.columns = [
      { header: 'Student', width: 28 },
      ...homework.map(h => ({ header: h.title, width: Math.min(40, Math.max(16, h.title.length + 2)) })),
    ];
    for (const s of students) {
      const row = hw.addRow([s.name, ...homework.map(h => { const a = h.done.get(s.id); return a ? `Done ${mark(a)}` : 'Not done'; })]);
      homework.forEach((h, i) => { row.getCell(i + 2).font = { color: { argb: h.done.get(s.id) ? 'FF1F7A4D' : 'FFB42318' } }; });
    }
    hw.getRow(1).font = { bold: true };
    hw.getRow(1).alignment = { wrapText: true, vertical: 'middle' };
  }

  const buf = await wb.xlsx.writeBuffer();
  const safe = `${group.name}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'group';
  return {
    students: students.length, tests: tests.length, attempts: attempts.length, nobody, perStudent,
    homework: homework.map(h => ({ title: h.title, due_at: h.due_at,
      students: students.map(s => { const a = h.done.get(s.id); return { name: s.name, done: !!a, mark: a ? mark(a) : null, passed: !!a?.passed }; }) })),
    fileName: `${safe}-marks-${cairoDay(until).iso}.xlsx`,
    base64: Buffer.from(buf).toString('base64'),
  };
}

// A test's name as the teacher reads it: its title, the lesson when the
// title doesn't already say it, the section, and whether it was on paper.
export function testLabel(t = {}) {
  const lesson = t.lessons?.title;
  const section = t.test_sections?.name;
  let label = t.title || 'Test';
  if (lesson && !label.toLowerCase().includes(lesson.toLowerCase())) label += ` — ${lesson}`;
  if (section) label += ` (${section})`;
  if (t.is_offline) label += ' — in class';
  return label;
}

// The homework this session checks: tests set to this group (or to the
// whole course) that fell due since the group last met, up to the day
// after the report, plus any set since then with no deadline. For each,
// who has done it — at any time after it was set, not only this week.
async function homeworkFor(group, students, from, until) {
  if (!students.length) return [];
  const { data: set } = await admin.from('test_assignments')
    .select('test_id, group_id, due_at, created_at, practice_tests(title, course_id, is_offline, test_sections(name), lessons(title))')
    .eq('course_id', group.course_id);
  const upTo = new Date(until.getTime() + 2 * DAY_MS);
  const due = (set || []).filter(a => (!a.group_id || a.group_id === group.id) && (a.due_at
    ? new Date(a.due_at) >= from && new Date(a.due_at) <= upTo
    : new Date(a.created_at) >= from && new Date(a.created_at) <= until));
  const byTest = new Map();
  for (const a of due) if (!byTest.has(a.test_id) || a.group_id) byTest.set(a.test_id, a);   // the group's own row wins
  if (!byTest.size) return [];
  const { data: tries } = await admin.from('test_attempts')
    .select('student_id, test_id, score, max_score, percentage, passed, completed_at')
    .in('test_id', [...byTest.keys()]).in('student_id', students.map(s => s.id))
    .lte('completed_at', until.toISOString());
  return [...byTest.values()]
    .sort((a, b) => new Date(a.due_at || a.created_at) - new Date(b.due_at || b.created_at))
    .map(a => {
      const done = new Map();
      for (const t of tries || []) {
        if (t.test_id !== a.test_id || new Date(t.completed_at) < new Date(a.created_at)) continue;
        const cur = done.get(t.student_id);
        if (!cur || Number(t.percentage) > Number(cur.percentage)) done.set(t.student_id, t);
      }
      return { title: testLabel(a.practice_tests), due_at: a.due_at, done };
    });
}

const SITE = () => {
  const u = (process.env.PUBLIC_URL || 'https://lumenlearn.site').trim().replace(/\/$/, '');
  return u.startsWith('http') ? u : 'https://' + u;
};

export function reportEmail({ group, when, from, report }) {
  const { esc, pill, MUTED, LINE, INK } = reportBits;
  const since = from.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const did = report.students - report.nobody.length;

  const active = report.perStudent.filter(p => p.done).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
  const table = active.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${active.map(p => `
      <tr>
        <td valign="top" style="padding:10px 8px 10px 0;border-bottom:1px solid ${LINE};font-size:14px;font-weight:600;color:${INK};width:38%">${esc(p.name)}
          <div style="font-size:12px;font-weight:400;color:${MUTED};margin-top:2px">${p.done} test${p.done === 1 ? '' : 's'}</div></td>
        <td valign="top" style="padding:9px 0;border-bottom:1px solid ${LINE};line-height:2">
          ${p.marks.map(m => `<div style="font-size:13px;line-height:1.5;color:${INK};padding:2px 0">${pill(m.mark, m.passed ? 'good' : 'bad')} <span style="color:${MUTED}">${esc(m.title)}</span></div>`).join('')}
        </td>
      </tr>`).join('')}
    </table>
    <p style="margin:8px 0 0;font-size:12px;color:${MUTED}">Each mark is the student's best on that test. Green passed, red did not.</p>`
    : `<p style="margin:12px 0 0;font-size:14px;color:${MUTED}">Nobody in this group has done a test since ${esc(since)}.</p>`;

  const sections = [];
  for (const h of report.homework || []) {
    const doneN = h.students.filter(x => x.done).length;
    const due = h.due_at ? new Date(h.due_at).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }) : '';
    sections.push({
      title: `Homework: ${h.title}`, sub: `${doneN} of ${h.students.length} did it${due ? ` · due ${due}` : ''}`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${h.students.map(x => `
      <tr>
        <td style="padding:7px 8px 7px 0;border-bottom:1px solid ${LINE};font-size:14px;color:${INK}">${esc(x.name)}</td>
        <td align="right" style="padding:7px 0;border-bottom:1px solid ${LINE}">${x.done ? pill(`Done · ${x.mark}`, x.passed ? 'good' : 'bad') : pill('Not done', 'bad')}</td>
      </tr>`).join('')}</table>`,
    });
  }
  sections.push({ title: 'Marks so far', sub: `since ${since}`, html: table });
  if (report.nobody.length) {
    sections.push({
      title: 'Nothing done yet', sub: `${report.nobody.length} student${report.nobody.length === 1 ? '' : 's'}`,
      html: `<p style="margin:12px 0 0;font-size:14px;line-height:1.9">${report.nobody.map(n => pill(n, 'bad')).join(' ')}</p>`,
    });
  }

  return teacherReport({
    eyebrow: 'Group marks report',
    heading: `${group.name} · ${group.courses?.title || ''}`,
    intro: `This group meets <strong>${esc(when)}</strong>. Here is what its students have done since ${esc(since)}.`,
    tiles: [
      [String(report.students), 'Students'],
      ...((report.homework || []).length ? [[String(report.homework.reduce((n, h) => n + h.students.filter(x => !x.done).length, 0)), 'Homework missed', 'bad']] : []),
      [String(did), 'Did a test'],
      [String(report.nobody.length), 'Did nothing', report.nobody.length ? 'bad' : ''],
      [String(report.tests), 'Tests'],
    ],
    sections,
    button: { label: 'Open Progress in Lumen', url: SITE() + '/teacher/progress' },
    footer: 'The full sheet is attached — one row per student, one column per test, and a Homework tab.<br>Sent by Lumen the morning before each group session.',
  });
}

// A trial run for checking the email and the sheet: the real report for
// this teacher's groups, sent only to Lumen's own inbox, marked TEST, and
// not recorded — so the real morning email still goes out as usual.
// The groups that meet tomorrow, or else the next one to meet.
export async function runGroupReportTest(teacherId, inbox, now = new Date()) {
  const today = cairoDay(now);
  const { data: groups } = await admin.from('groups')
    .select('*, courses(title)').eq('teacher_id', teacherId);
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
    sentFor.push({ group: g.name, when, students: report.students, tests: report.tests, sent: out.sent, files: out.files || [], pdfError: out.pdfError || null, error: out.error || null });
  }
  return { to: inbox, groups: sentFor };
}

// "Send now" from the Groups list: the same email, straight away, to the
// teacher. It covers everything since the group's last session before
// today, and is not recorded, so the morning email still goes out too.
export async function sendGroupReportNow(groupId, teacherId, now = new Date()) {
  const { data: g } = await admin.from('groups')
    .select('*, courses(title)').eq('id', groupId).single();
  if (!g || g.teacher_id !== teacherId) return { error: 'That group was not found.' };
  const today = cairoDay(now);
  const back = (g.days || []).length ? daysSinceLastSession(g.days, today.dow) : 7;
  const from = cairoMidnight(addDays(today.iso, -back));
  const report = await buildReport(g, from, now);
  const to = await recipients(g);
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
