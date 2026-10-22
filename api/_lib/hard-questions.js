import ExcelJS from 'exceljs';
import { admin } from './supabase.js';
import { sendEmail, teacherReport, reportBits } from './email.js';
import { logActivity } from './auth.js';
import { cairoDay, cairoMidnight, addDays, reportRecipients } from './group-report.js';
import { htmlToPdf, lastPdfError } from './pdf.js';

// Every morning, the questions students found hardest over the last week.
//
// For each teacher: every test sat on Lumen over the last week (Cairo
// time), question by question — how many of the students who sat it got
// it wrong. A blank counts as wrong: the student did not get it right.
// Papers done in class have no questions and are left out.
//
// One email per course (Senior 1, Senior 2, Senior 3 each on its own),
// carrying three files: the course's Excel sheet with every question it
// got wrong, and two PDFs of its hardest questions to print — a worksheet
// for the students with no answers on it, and the answer key.
//
// Sent by the morning run (GET /api/health?task=morning), to the same
// addresses as the group reports. notify_log keeps it to one a day.

const TOP = 25;     // per course
const DAYS = 7;     // how far back each morning's email looks
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
      .select('id, test_id, question_text, options, explanation, image_url, order_index').in('test_id', chunk)));
  }

  const byTest = new Map();
  questions.forEach(q => { if (!byTest.has(q.test_id)) byTest.set(q.test_id, []); byTest.get(q.test_id).push(q); });

  const stats = new Map();     // question id -> { q, sat, wrong, picks: Map(index -> count) }
  for (const a of sat) {
    for (const q of byTest.get(a.test_id) || []) {
      const s = stats.get(q.id) || { q, test: a.practice_tests, sat: 0, wrong: 0, blank: 0, picks: new Map(), attempts: new Set() };
      s.sat++;
      s.attempts.add(a.id);
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
      options: (s.q.options || []).map(o => o?.text ?? ''),
      right: right(s.q),
      explanation: s.q.explanation || '',
      image: s.q.image_url || '',
      answer: right(s.q).map(i => s.q.options[i]?.text).join(' / '),
      commonWrong: common ? `${s.q.options[common[0]]?.text ?? ''} (${common[1]})` : '',
      sat: s.sat, wrong: s.wrong, blank: s.blank, attemptIds: [...s.attempts],
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

async function sheet(rows, dayIso, slug = '') {
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
  return { name: `hardest-questions-${slug ? slug + '-' : ''}${dayIso}.xlsx`, content: Buffer.from(buf).toString('base64') };
}

// "Senior 2" -> "Senior-2", for file names.
const slugOf = (course) => String(course || 'Course').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'Course';
const LETTERS = 'ABCDEFGH';

// The hardest questions of one course as a page to print: `key` false is
// the students' worksheet — nothing on it gives the answer away — and
// `key` true is the same questions in the same order with the right
// answer marked and the explanation under it. The whole question goes on
// the page, reading passage included: a student cannot answer from half.
// A reading passage above its question is set in plain type; the
// question itself, the last paragraph, in bold.
function qText(text) {
  const { esc } = reportBits;
  const parts = String(text || '').split('\n\n');
  const q = parts.pop();
  return `${parts.length ? `<div class="pt" dir="auto">${esc(parts.join('\n\n'))}</div>` : ''}<div class="qt" dir="auto">${esc(q)}</div>`;
}

export function printSheet({ course, dayLabel, list, key, spaceName = '' }) {
  const { esc } = reportBits;
  const items = list.map((r, i) => `
    <section class="q">
      <div class="qn">${i + 1}.</div>
      <div class="qb">
        ${key ? `<div class="meta">${esc(r.test)} · Q${r.number} · ${r.wrong} of ${r.sat} got it wrong</div>` : ''}
        ${qText(r.question)}
        ${r.image ? `<img class="fig" src="${esc(r.image)}" alt="">` : ''}
        <ol class="opts">${r.options.map((o, j) => {
          const ok = key && r.right.includes(j);
          return `<li class="${ok ? 'ok' : ''}"><span class="b">${ok ? '&#10003;' : LETTERS[j] || j + 1}</span><span dir="auto">${esc(o)}</span></li>`;
        }).join('')}</ol>
        ${key ? `<div class="ans">Answer: ${r.right.map(j => LETTERS[j] || j + 1).join(' and ')}</div>` : ''}
        ${key && r.explanation ? `<div class="ex" dir="auto">${esc(r.explanation)}</div>` : ''}
      </div>
    </section>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: Arial, sans-serif; color: #1B1A1F; font-size: 12.5px; line-height: 1.45; margin: 0; }
    header { border-bottom: 2px solid #1B1A1F; padding-bottom: 8px; margin-bottom: 14px; }
    h1 { font-size: 19px; margin: 0 0 2px; }
    .sub { color: #555; font-size: 12px; }
    .who { display: flex; gap: 28px; margin-top: 12px; font-size: 13px; }
    .who span { flex: 1; border-bottom: 1px solid #999; padding-bottom: 2px; }
    .q { display: flex; gap: 8px; padding: 10px 0; border-bottom: 1px solid #E4E1E6; break-inside: avoid; page-break-inside: avoid; }
    .qn { font-weight: 700; min-width: 24px; }
    .qb { flex: 1; min-width: 0; }
    .meta { color: #777; font-size: 10.5px; margin-bottom: 3px; }
    .pt { white-space: pre-line; margin-bottom: 6px; }
    .qt { white-space: pre-line; font-weight: 600; margin-bottom: 6px; }
    .fig { display: block; max-width: 70%; max-height: 260px; margin: 4px 0 8px; }
    .opts { list-style: none; margin: 0; padding: 0; }
    .opts li { display: flex; gap: 8px; align-items: flex-start; padding: 2px 0; }
    .opts .b { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.3px solid #555; border-radius: 50%; font-size: 10px; font-weight: 700; flex: none; }
    .opts li.ok { font-weight: 700; color: #1F7A4D; }
    .opts li.ok .b { background: #1F7A4D; border-color: #1F7A4D; color: #fff; }
    .ans { margin-top: 5px; font-weight: 700; color: #1F7A4D; }
    .ex { margin-top: 3px; color: #444; font-size: 11.5px; }
  </style></head><body>
    <header>
      <h1>${esc(course)} — ${key ? 'Answer key' : 'Practice: the questions most students missed'}</h1>
      <div class="sub">${esc(spaceName ? spaceName + ' · ' : '')}${list.length} question${list.length === 1 ? '' : 's'} · from the tests sat over ${esc(dayLabel)}</div>
      ${key ? '' : '<div class="who"><span>Name:</span><span>Group:</span><span>Score:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;/ ' + list.length + '</span></div>'}
    </header>
    ${items}
  </body></html>`;
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

// `course`: the email for one course only. Without it, every course in
// one email, as the trial samples show it.
export function hardEmail({ dayLabel, result, course = null }) {
  const { esc } = reportBits;
  const courses = byCourse(result.questions).filter(([c]) => !course || c === course);
  const asked = courses.reduce((n, [, l]) => n + l.length, 0);
  const sat = course ? new Set(result.questions.filter(q => (q.course || 'Other') === course).flatMap(q => q.attemptIds || [])).size : result.attempts;
  return teacherReport({
    eyebrow: course ? `Hardest questions · ${course}` : 'Hardest questions',
    heading: course ? `Where ${course} struggled` : `Where students struggled`,
    intro: `The questions most students got wrong in the tests sat over <strong>${esc(dayLabel)}</strong>${course ? '' : ', course by course'}. A blank answer counts as wrong.`
      + (course ? ' Attached: a worksheet of the hardest ones to print for the students, with no answers on it, and its answer key.' : ''),
    tiles: [
      [String(sat), 'Tests sat'],
      [String(asked), 'Questions got wrong', 'bad'],
      ...(course ? [[String(Math.min(TOP, courses[0]?.[1].length || 0)), 'On the worksheet']] : [[String(courses.length), courses.length === 1 ? 'Course' : 'Courses']]),
    ],
    sections: courses.map(([course, list]) => ({
      title: course,
      sub: `the ${Math.min(TOP, list.length)} hardest of ${list.length}`,
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list.slice(0, TOP).map(card).join('')}</table>`,
    })),
    button: { label: 'Open Test results in Lumen', url: SITE() + '/teacher/results' },
    footer: (course ? 'Every question anybody got wrong is in the attached sheet, hardest first.' : 'Every question anybody got wrong is in the attached sheet — one tab per course, hardest first.') + '<br>Sent by Lumen every morning.',
  });
}

// For each teacher who had tests sat over the week: one email per course,
// to each recipient.
export async function runHardQuestions(now = new Date(), { onlyTeacher = null, to = null, force = false } = {}) {
  // `force`: a button press. It always sends, and does not use up the morning's.
  const record = !to && !force;
  const today = cairoDay(now);
  // The seven days up to last night: enough tests in every course for the
  // hard questions to stand out, even after a quiet day.
  const dayIso = addDays(today.iso, -1);
  const firstIso = addDays(today.iso, -DAYS);
  const from = cairoMidnight(firstIso), until = cairoMidnight(today.iso);
  const fmt = (iso, o) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', o);
  const dayLabel = `the last ${DAYS} days (${fmt(firstIso, { day: 'numeric', month: 'short' })} – ${fmt(dayIso, { day: 'numeric', month: 'short' })})`;

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
      const { data: t } = await admin.from('teachers').select('display_name').eq('id', teacherId).maybeSingle();
      const sent = [];
      for (const [course, list] of byCourse(result.questions)) {
        const slug = slugOf(course);
        const top = list.slice(0, TOP);
        const files = [await sheet(list, dayIso, slug)];
        let pdfError = null;
        for (const [withAnswers, label] of [[false, 'worksheet'], [true, 'answer-key']]) {
          const pdf = await htmlToPdf(printSheet({ course, dayLabel, list: top, key: withAnswers, spaceName: t?.display_name || '' }));
          if (pdf) files.push({ name: `${slug}-hardest-questions-${label}-${dayIso}.pdf`, content: pdf.toString('base64') });
          else pdfError = pdfError || lastPdfError;
        }
        for (const r of recipients) {
          const res = await sendEmail({
            to: r.email, toName: r.name,
            subject: `${to ? '[TEST] ' : ''}Hardest questions — ${course} — ${dayLabel}`,
            html: hardEmail({ dayLabel, result, course }), attachments: files,
            // The worksheet and the key are the PDFs; a third, of the
            // email itself, would only be in the way of printing.
            pdf: false,
          });
          sent.push({ to: r.email, course, sent: res.sent, files: res.files || [], error: res.error || null, ...(pdfError ? { pdfError } : {}) });
        }
      }
      if (!to) {
        if (record && !sent.some(s => s.sent)) await admin.from('notify_log').delete().eq('key', key);
        else if (sent.some(s => s.sent)) await logActivity(teacherId, null, 'hard_questions_sent', `${dayLabel} · ${[...new Set(sent.filter(s => s.sent).map(s => s.course))].join(', ')} → ${[...new Set(sent.filter(s => s.sent).map(s => s.to))].join(', ')}`);
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
