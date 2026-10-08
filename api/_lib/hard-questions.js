import ExcelJS from 'exceljs';
import { admin } from './supabase.js';
import { sendEmail, teacherReport, reportBits } from './email.js';
import { logActivity } from './auth.js';
import { cairoDay, cairoMidnight, addDays, reportRecipients } from './group-report.js';

// Every morning, the questions students found hardest yesterday.
//
// For each teacher: every test sat on Lumen during yesterday (Cairo
// time), question by question — how many of the students who sat it got
// it wrong. A blank counts as wrong: the student did not get it right.
// The email lists the hardest fifteen with the right answer and the
// wrong answer most of them chose; the Excel sheet has every question,
// hardest first. Papers done in class have no questions and are left out.
//
// Sent by the morning run (GET /api/health?task=morning), to the same
// address as the group reports. notify_log keeps it to one a day.

const TOP = 10;     // per course
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

const right = (q) => (q.options || []).map((o, i) => (o?.correct ? i : -1)).filter(i => i >= 0);

function isRight(q, given) {
  const want = right(q);
  const got = given == null ? [] : (Array.isArray(given) ? given : [given]).map(Number);
  return got.length === want.length && want.every(i => got.includes(i));
}

// The hardest questions among the attempts in [from, until), per teacher.
export async function hardestQuestions(teacherId, from, until) {
  const attempts = await everyRow(() => admin.from('test_attempts')
    .select('id, test_id, answers, practice_tests(title, is_offline, courses(title))')
    .eq('teacher_id', teacherId).not('completed_at', 'is', null)
    .gte('completed_at', from.toISOString()).lt('completed_at', until.toISOString()));
  const sat = attempts.filter(a => a.answers && !a.practice_tests?.is_offline);
  if (!sat.length) return { attempts: 0, questions: [] };

  const testIds = [...new Set(sat.map(a => a.test_id))];
  const questions = [];
  for (let i = 0; i < testIds.length; i += 100) {
    const chunk = testIds.slice(i, i + 100);
    questions.push(...await everyRow(() => admin.from('test_questions')
      .select('id, test_id, question_text, options, order_index').in('test_id', chunk)));
  }

  const byTest = new Map();
  questions.forEach(q => { if (!byTest.has(q.test_id)) byTest.set(q.test_id, []); byTest.get(q.test_id).push(q); });

  const stats = new Map();     // question id -> { q, sat, wrong, picks: Map(index -> count) }
  for (const a of sat) {
    for (const q of byTest.get(a.test_id) || []) {
      const s = stats.get(q.id) || { q, test: a.practice_tests, sat: 0, wrong: 0, blank: 0, picks: new Map() };
      s.sat++;
      const given = a.answers[q.id];
      if (!isRight(q, given)) {
        s.wrong++;
        if (given == null) s.blank++;
        else (Array.isArray(given) ? given : [given]).forEach(i => {
          if (!right(q).includes(Number(i))) s.picks.set(Number(i), (s.picks.get(Number(i)) || 0) + 1);
        });
      }
      stats.set(q.id, s);
    }
  }

  const list = [...stats.values()].map(s => {
    const common = [...s.picks.entries()].sort((x, y) => y[1] - x[1])[0];
    return {
      test: s.test?.title || 'Test', course: s.test?.courses?.title || '',
      number: (s.q.order_index ?? 0) + 1,
      question: s.q.question_text,
      answer: right(s.q).map(i => s.q.options[i]?.text).join(' / '),
      commonWrong: common ? `${s.q.options[common[0]]?.text ?? ''} (${common[1]})` : '',
      sat: s.sat, wrong: s.wrong, blank: s.blank,
      pct: Math.round((s.wrong / s.sat) * 100),
    };
  })
    // A question one student got wrong is not "hard"; it needs a few sitters.
    .filter(r => r.wrong > 0)
    .sort((x, y) => (y.wrong - x.wrong) || (y.pct - x.pct) || (y.sat - x.sat));

  return { attempts: sat.length, questions: list };
}

// The courses in a fixed order (Senior 1, Senior 2, Senior 3), each with
// its questions hardest first.
function byCourse(rows) {
  const m = new Map();
  rows.forEach(r => { const k = r.course || 'Other'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

async function sheet(rows, dayIso) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lumen';
  for (const [course, list] of byCourse(rows)) {
    // A sheet name may not hold : \ / ? * [ ] and is at most 31 characters.
    const ws = wb.addWorksheet(course.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Wrong', width: 8 }, { header: 'Sat it', width: 8 }, { header: '% wrong', width: 9 },
      { header: 'Left blank', width: 10 }, { header: 'Test', width: 32 },
      { header: 'Q', width: 5 }, { header: 'Question', width: 70 }, { header: 'Right answer', width: 28 },
      { header: 'Most chosen wrong answer', width: 30 },
    ];
    list.forEach(r => ws.addRow([r.wrong, r.sat, r.pct, r.blank, r.test, r.number,
      r.question.length > 600 ? r.question.slice(0, 600) + '…' : r.question, r.answer, r.commonWrong]));
    ws.getRow(1).font = { bold: true };
    ws.getColumn(7).alignment = { wrapText: true, vertical: 'top' };
  }
  const buf = await wb.xlsx.writeBuffer();
  return { name: `hardest-questions-${dayIso}.xlsx`, content: Buffer.from(buf).toString('base64') };
}

// Long reading passages are cut to the question itself for the email.
function shortQuestion(t) {
  const parts = String(t || '').split('\n\n');
  const q = parts[parts.length - 1];
  return q.length > 220 ? q.slice(0, 219) + '…' : q;
}

const SITE = () => {
  const u = (process.env.PUBLIC_URL || 'https://lumenlearn.site').trim().replace(/\/$/, '');
  return u.startsWith('http') ? u : 'https://' + u;
};

function card(r, i) {
  const { esc, pill, MUTED, LINE, INK } = reportBits;
  return `
    <tr>
      <td valign="top" width="86" style="padding:14px 10px 14px 0;border-bottom:1px solid ${LINE}">
        ${pill(`${r.wrong}/${r.sat} wrong`, 'bad')}
      </td>
      <td valign="top" style="padding:13px 0;border-bottom:1px solid ${LINE}">
        <div style="font-size:12px;color:${MUTED}">${i + 1} · ${esc(r.test)} · Q${r.number}</div>
        <div style="margin:4px 0 7px;font-size:15px;line-height:1.5;color:${INK}" dir="auto">${esc(shortQuestion(r.question))}</div>
        <div style="font-size:13px;line-height:1.7">
          <span style="color:#1F7A4D;font-weight:600">&#10003; ${esc(r.answer)}</span>
          ${r.commonWrong ? `&nbsp;&nbsp;<span style="color:#B42318">&#10007; most chose ${esc(r.commonWrong)}</span>` : ''}
          ${r.blank ? `&nbsp;&nbsp;<span style="color:${MUTED}">${r.blank} left it blank</span>` : ''}
        </div>
      </td>
    </tr>`;
}

export function hardEmail({ dayLabel, result }) {
  const { esc } = reportBits;
  const courses = byCourse(result.questions);
  return teacherReport({
    eyebrow: 'Hardest questions',
    heading: `Where students struggled · ${dayLabel}`,
    intro: `The questions most students got wrong in the tests sat on <strong>${esc(dayLabel)}</strong>, course by course. A blank answer counts as wrong.`,
    tiles: [
      [String(result.attempts), 'Tests sat'],
      [String(result.questions.length), 'Questions got wrong', 'bad'],
      [String(courses.length), courses.length === 1 ? 'Course' : 'Courses'],
    ],
    sections: courses.map(([course, list]) => ({
      title: course,
      sub: `the ${Math.min(TOP, list.length)} hardest of ${list.length}`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.slice(0, TOP).map(card).join('')}</table>`,
    })),
    button: { label: 'Open Test results in Lumen', url: SITE() + '/teacher/results' },
    footer: 'Every question anybody got wrong is in the attached sheet — one tab per course, hardest first.<br>Sent by Lumen every morning.',
  });
}

// One email per teacher who had any tests sat yesterday.
export async function runHardQuestions(now = new Date(), { onlyTeacher = null, to = null, force = false } = {}) {
  // `force`: a button press. It always sends, and does not use up the morning's.
  const record = !to && !force;
  const today = cairoDay(now);
  const dayIso = addDays(today.iso, -1);
  const from = cairoMidnight(dayIso), until = cairoMidnight(today.iso);
  const dayLabel = new Date(`${dayIso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  let teachers;
  if (onlyTeacher) teachers = [onlyTeacher];
  else {
    const { data } = await admin.from('test_attempts').select('teacher_id')
      .gte('completed_at', from.toISOString()).lt('completed_at', until.toISOString()).limit(1000);
    teachers = [...new Set((data || []).map(r => r.teacher_id))];
  }

  const out = [];
  for (const teacherId of teachers) {
    const key = `hard-questions:${teacherId}:${dayIso}`;
    if (record) {
      const { error: dupe } = await admin.from('notify_log').insert({ key });
      if (dupe) continue;
    }
    try {
      const result = await hardestQuestions(teacherId, from, until);
      if (!result.questions.length) { out.push({ teacherId, questions: 0, sent: [] }); continue; }
      const recipients = to ? [{ email: to, name: 'Lumen' }] : await reportRecipients(teacherId);
      const attachment = await sheet(result.questions, dayIso);
      const sent = [];
      for (const r of recipients) {
        const res = await sendEmail({
          to: r.email, toName: r.name,
          subject: `${to ? '[TEST] ' : ''}Hardest questions — ${dayLabel}`,
          html: hardEmail({ dayLabel, result }), attachments: [attachment],
        });
        sent.push({ to: r.email, sent: res.sent, error: res.error || null });
      }
      if (!to) {
        if (record && !sent.some(s => s.sent)) await admin.from('notify_log').delete().eq('key', key);
        else if (sent.some(s => s.sent)) await logActivity(teacherId, null, 'hard_questions_sent', `${dayLabel} → ${sent.filter(s => s.sent).map(s => s.to).join(', ')}`);
      }
      out.push({ teacherId, questions: result.questions.length, attempts: result.attempts, sent });
    } catch (err) {
      console.error('hardest questions failed for', teacherId, err);
      if (record) await admin.from('notify_log').delete().eq('key', key);
      out.push({ teacherId, error: err.message });
    }
  }
  return { day: dayIso, teachers: out };
}
