import ExcelJS from 'exceljs';
import { admin } from './supabase.js';
import { sendEmail } from './email.js';
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

const TOP = 15;
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

async function sheet(rows, dayIso) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lumen';
  const ws = wb.addWorksheet('Hardest questions', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Wrong', width: 8 }, { header: 'Sat it', width: 8 }, { header: '% wrong', width: 9 },
    { header: 'Left blank', width: 10 }, { header: 'Course', width: 12 }, { header: 'Test', width: 32 },
    { header: 'Q', width: 5 }, { header: 'Question', width: 70 }, { header: 'Right answer', width: 28 },
    { header: 'Most chosen wrong answer', width: 30 },
  ];
  rows.forEach(r => ws.addRow([r.wrong, r.sat, r.pct, r.blank, r.course, r.test, r.number,
    r.question.length > 600 ? r.question.slice(0, 600) + '…' : r.question, r.answer, r.commonWrong]));
  ws.getRow(1).font = { bold: true };
  ws.getColumn(8).alignment = { wrapText: true, vertical: 'top' };
  const buf = await wb.xlsx.writeBuffer();
  return { name: `hardest-questions-${dayIso}.xlsx`, content: Buffer.from(buf).toString('base64') };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Long reading passages are cut to the question itself for the email.
function shortQuestion(t) {
  const parts = String(t || '').split('\n\n');
  const q = parts[parts.length - 1];
  return q.length > 220 ? q.slice(0, 219) + '…' : q;
}

function email({ dayLabel, result }) {
  const top = result.questions.slice(0, TOP);
  const rows = top.map((r, i) => `
    <tr>
      <td style="padding:8px 6px;border-bottom:1px solid #EDDDE6;vertical-align:top;font-weight:700;color:#B42318;white-space:nowrap">${r.wrong}/${r.sat}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #EDDDE6;vertical-align:top">
        <div style="font-size:12px;color:#8B8089">${i + 1}. ${esc(r.course)} · ${esc(r.test)} · Q${r.number}</div>
        <div style="margin:2px 0 4px" dir="auto">${esc(shortQuestion(r.question))}</div>
        <div style="font-size:13px"><span style="color:#1F7A4D">Right: ${esc(r.answer)}</span>${r.commonWrong ? ` · <span style="color:#B42318">Most chose: ${esc(r.commonWrong)}</span>` : ''}${r.blank ? ` · ${r.blank} left it blank` : ''}</div>
      </td>
    </tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1B1519;line-height:1.45;max-width:640px">
    <p style="margin:0 0 10px">The questions students found hardest on <strong>${esc(dayLabel)}</strong>, from ${result.attempts} test${result.attempts === 1 ? '' : 's'} sat.</p>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    <p style="margin:16px 0 0">Every question that anybody got wrong is in the attached sheet, hardest first.</p>
    <p style="margin:16px 0 0;color:#8B8089;font-size:13px">Sent by Lumen every morning.</p>
  </div>`;
}

// One email per teacher who had any tests sat yesterday.
export async function runHardQuestions(now = new Date(), { onlyTeacher = null, to = null } = {}) {
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
    if (!to) {
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
          html: email({ dayLabel, result }), attachments: [attachment],
        });
        sent.push({ to: r.email, sent: res.sent, error: res.error || null });
      }
      if (!to) {
        if (!sent.some(s => s.sent)) await admin.from('notify_log').delete().eq('key', key);
        else await logActivity(teacherId, null, 'hard_questions_sent', `${dayLabel} → ${sent.filter(s => s.sent).map(s => s.to).join(', ')}`);
      }
      out.push({ teacherId, questions: result.questions.length, attempts: result.attempts, sent });
    } catch (err) {
      console.error('hardest questions failed for', teacherId, err);
      if (!to) await admin.from('notify_log').delete().eq('key', key);
      out.push({ teacherId, error: err.message });
    }
  }
  return { day: dayIso, teachers: out };
}
