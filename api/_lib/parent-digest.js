import { admin } from './supabase.js';
import { sendEmail, teacherReport, reportBits } from './email.js';
import { logActivity } from './auth.js';
import { cairoDay, cairoMidnight, addDays, reportRecipients } from './group-report.js';

// Every morning, the results Lumen emailed to parents the day before.
//
// A parent hears about each test the moment their child finishes it
// (api/result-email.js). The teacher and the assistants do not want a
// copy of each of those — at the pace of a busy week that is a hundred
// emails — so they get one list instead: student, test, mark, and the
// address it went to. Sent by the morning run, to the same addresses as
// the group reports. notify_log keeps it to one a day.

const PAGE = 1000;

async function everyRow(makeQuery) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

// The results emailed to parents in [from, until), course by course.
export async function parentResults(teacherId, from, until) {
  const rows = await everyRow(() => admin.from('test_attempts')
    .select('id, score, max_score, percentage, passed, parent_emailed_at, profiles(full_name, parent_email), practice_tests(title, courses(title))')
    .eq('teacher_id', teacherId)
    .gte('parent_emailed_at', from.toISOString()).lt('parent_emailed_at', until.toISOString()));
  return rows.map(r => ({
    student: r.profiles?.full_name || 'A student',
    parent: r.profiles?.parent_email || '',
    test: r.practice_tests?.title || 'Test',
    course: r.practice_tests?.courses?.title || 'Other',
    mark: r.score != null && r.max_score != null ? `${r.score}/${r.max_score}` : `${Math.round(parseFloat(r.percentage) || 0)}%`,
    passed: !!r.passed,
    at: r.parent_emailed_at,
  })).sort((a, b) => a.course.localeCompare(b.course, undefined, { numeric: true })
    || a.student.localeCompare(b.student) || a.at.localeCompare(b.at));
}

export function digestEmail({ dayLabel, rows }) {
  const { esc, pill, MUTED, LINE, INK } = reportBits;
  const byCourse = new Map();
  rows.forEach(r => { if (!byCourse.has(r.course)) byCourse.set(r.course, []); byCourse.get(r.course).push(r); });
  const table = (list) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.map(r => `
    <tr>
      <td style="padding:9px 8px 9px 0;border-bottom:1px solid ${LINE};font-size:14px;color:${INK}" dir="auto">${esc(r.student)}</td>
      <td style="padding:9px 8px;border-bottom:1px solid ${LINE};font-size:13px;color:${MUTED}" dir="auto">${esc(r.test)}</td>
      <td style="padding:9px 0 9px 8px;border-bottom:1px solid ${LINE};text-align:right;white-space:nowrap">${pill(r.mark, r.passed ? 'good' : 'bad')}</td>
    </tr>
    <tr><td colspan="3" style="padding:0 0 8px;font-size:11px;color:${MUTED}">to ${esc(r.parent || '—')}</td></tr>`).join('')}</table>`;
  const passed = rows.filter(r => r.passed).length;
  return teacherReport({
    eyebrow: 'Sent to parents',
    heading: 'Results parents were told about',
    intro: `Every result Lumen emailed to a parent on <strong>${esc(dayLabel)}</strong>, so you know what each family has heard.`,
    tiles: [
      [String(rows.length), rows.length === 1 ? 'Result sent' : 'Results sent'],
      [String(passed), 'Passed', 'good'],
      [String(rows.length - passed), 'Below the pass mark', 'bad'],
    ],
    sections: [...byCourse.entries()].map(([course, list]) => ({ title: course, sub: `${list.length} result${list.length === 1 ? '' : 's'}`, html: table(list) })),
    footer: 'Parents get each result the moment their child finishes a test. This is the list of them.<br>Sent by Lumen every morning.',
  });
}

export async function runParentDigest(now = new Date(), { onlyTeacher = null, to = null, force = false } = {}) {
  const record = !to && !force;
  const today = cairoDay(now);
  const dayIso = addDays(today.iso, -1);
  const from = cairoMidnight(dayIso), until = cairoMidnight(today.iso);
  const dayLabel = new Date(`${dayIso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  let teachers;
  if (onlyTeacher) teachers = [onlyTeacher];
  else {
    const { data } = await admin.from('test_attempts').select('teacher_id')
      .gte('parent_emailed_at', from.toISOString()).lt('parent_emailed_at', until.toISOString()).limit(1000);
    teachers = [...new Set((data || []).map(r => r.teacher_id))];
  }

  const out = [];
  for (const teacherId of teachers) {
    const key = `parent-digest:${teacherId}:${dayIso}`;
    if (record) {
      const { error: dupe } = await admin.from('notify_log').insert({ key });
      if (dupe) continue;
    }
    try {
      const rows = await parentResults(teacherId, from, until);
      if (!rows.length) { out.push({ teacherId, results: 0, sent: [] }); continue; }
      const recipients = to ? [{ email: to, name: 'Lumen' }] : await reportRecipients(teacherId);
      const sent = [];
      for (const r of recipients) {
        const res = await sendEmail({
          to: r.email, toName: r.name,
          subject: `${to ? '[TEST] ' : ''}Results sent to parents — ${dayLabel}`,
          html: digestEmail({ dayLabel, rows }),
        });
        sent.push({ to: r.email, sent: res.sent, files: res.files || [], error: res.error || null });
      }
      if (!to) {
        if (record && !sent.some(s => s.sent)) await admin.from('notify_log').delete().eq('key', key);
        else if (sent.some(s => s.sent)) await logActivity(teacherId, null, 'parent_digest_sent', `${dayLabel} · ${rows.length} results → ${sent.filter(s => s.sent).map(s => s.to).join(', ')}`);
      }
      out.push({ teacherId, results: rows.length, sent });
    } catch (err) {
      console.error('parent digest failed for', teacherId, err);
      if (record) await admin.from('notify_log').delete().eq('key', key);
      out.push({ teacherId, error: err.message });
    }
  }
  return { day: dayIso, teachers: out };
}
