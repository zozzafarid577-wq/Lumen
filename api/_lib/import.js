import { admin } from './supabase.js';
import { randomUUID } from 'node:crypto';
import { HttpError, requireRoles, requirePerm, tenantFor, assertTenant, logActivity } from './auth.js';
import { PRIVATE, PUBLIC, publicUrl, safeName, putObject, r2Ready } from './r2.js';
import { R2_FILE } from './files.js';

// Bringing a course in from another site (the first was Dr. Mai's Biology
// portal). Three steps, each its own call so none runs into the time limit:
//
//   import-course   the structure: course, units, lessons, tests with their
//                   questions, and bank questions — one call, all or nothing
//   import-file     one PDF, fetched here and stored on R2 for a lesson
//   import-picture  one question picture, fetched here and stored on R2
//
// Files are fetched server-side, so only addresses on hosts that hold
// course files are accepted — this is not a general "fetch any URL" tool.

const FILE_HOSTS = [/\.r2\.cloudflarestorage\.com$/i, /\.supabase\.co$/i];
const MAX_FILE_MB = 60;

function teacherOf(profile, body) {
  requireRoles(profile, ['teacher', 'assistant', 'owner']);
  if (profile.role !== 'owner') requirePerm(profile, 'courses');
  return tenantFor(profile, body.teacher_id);
}

async function fetchAllowed(url, { image = false } = {}) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { throw new HttpError(400, 'That is not a file address.'); }
  if (u.protocol !== 'https:' || !FILE_HOSTS.some(re => re.test(u.hostname))) {
    throw new HttpError(400, 'Files can only be brought in from Cloudflare R2 or Supabase storage.');
  }
  const res = await fetch(u.toString(), { redirect: 'error' });
  if (!res.ok) throw new HttpError(502, `The old site refused that file (${res.status}).`);
  const type = res.headers.get('content-type') || '';
  if (image && !/^image\//.test(type)) throw new HttpError(400, 'That address is not a picture.');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_FILE_MB * 1048576) throw new HttpError(400, `Files can be up to ${MAX_FILE_MB} MB.`);
  return { body, type: type || undefined };
}

const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

function options(list, n) {
  const out = (Array.isArray(list) ? list : []).map(o => ({ text: String(o?.text ?? '').trim().slice(0, 600), correct: o?.correct === true }));
  if (out.length < 2 || out.some(o => !o.text) || !out.some(o => o.correct)) throw new HttpError(400, `Question ${n} is not a complete multiple-choice question.`);
  return out;
}

export async function importCourse(profile, body) {
  const teacherId = teacherOf(profile, body);
  const c = body.course || {};
  const title = text(c.title, 120);
  if (!title) throw new HttpError(400, 'The course needs a title.');
  const units = Array.isArray(body.units) ? body.units : [];
  const tests = Array.isArray(body.tests) ? body.tests : [];
  const bank = Array.isArray(body.bank) ? body.bank : [];

  const { data: course, error: cErr } = await admin.from('courses').insert({
    teacher_id: teacherId, title, subject: text(c.subject, 80), description: text(c.description, 2000),
    exam_date: null, is_active: c.is_active !== false, order_index: Number(c.order_index) || 0,
  }).select('id').single();
  if (cErr) throw new HttpError(500, 'Could not create the course.');

  const lessonIds = {};   // the caller's lesson key → new lesson id
  const unitIds = [];
  const report = { course_id: course.id, title, units: 0, lessons: 0, tests: 0, questions: 0, bank: 0 };
  try {
    const unitRows = [], lessonRows = [];
    units.forEach((u, i) => {
      const id = randomUUID();
      unitIds.push(id);
      unitRows.push({ id, teacher_id: teacherId, course_id: course.id, title: text(u.title, 200) || `Unit ${i + 1}`,
        description: text(u.description, 2000), is_done: u.is_done !== false, open_at: null, order_index: i });
      (u.lessons || []).forEach((l, j) => {
        const lid = randomUUID();
        if (l.key) lessonIds[l.key] = lid;
        lessonRows.push({ id: lid, teacher_id: teacherId, module_id: id, title: text(l.title, 200) || `Lesson ${j + 1}`,
          description: text(l.description, 2000), video_url: null, duration_min: null, order_index: j });
      });
    });
    if (unitRows.length) { const { error } = await admin.from('modules').insert(unitRows); if (error) throw new Error('units: ' + error.message); }
    if (lessonRows.length) { const { error } = await admin.from('lessons').insert(lessonRows); if (error) throw new Error('lessons: ' + error.message); }
    report.units = unitRows.length; report.lessons = lessonRows.length;

    const testRows = [], qRows = [];
    tests.forEach((t, i) => {
      const id = randomUUID();
      const unit = Number.isInteger(t.unit) ? unitIds[t.unit] || null : null;
      testRows.push({ id, teacher_id: teacherId, course_id: course.id, module_id: unit,
        lesson_id: unit && t.lesson_key ? lessonIds[t.lesson_key] || null : null,
        title: text(t.title, 200) || `Test ${i + 1}`, description: text(t.description, 1000),
        time_limit_min: Number(t.time_limit_min) > 0 ? Math.round(t.time_limit_min) : null,
        passing_score_pct: Math.min(100, Math.max(0, Number(t.passing_score_pct) || 50)),
        open_at: null, close_at: null, is_active: t.is_active !== false, order_index: i });
      (t.questions || []).forEach((q, j) => qRows.push({ teacher_id: teacherId, test_id: id,
        question_text: text(q.question_text, 4000) || (() => { throw new HttpError(400, `${t.title}, question ${j + 1} has no text.`); })(),
        options: options(q.options, `${j + 1} of ${t.title}`), explanation: text(q.explanation, 2000),
        image_url: text(q.image_url, 500), order_index: j, points: Number(q.points) > 0 ? Math.round(q.points) : 1 }));
    });
    if (testRows.length) { const { error } = await admin.from('practice_tests').insert(testRows); if (error) throw new Error('tests: ' + error.message); }
    for (let i = 0; i < qRows.length; i += 500) {
      const { error } = await admin.from('test_questions').insert(qRows.slice(i, i + 500));
      if (error) throw new Error('questions: ' + error.message);
    }
    report.tests = testRows.length; report.questions = qRows.length;

    const bankRows = bank.map((q, j) => ({ teacher_id: teacherId, course_id: course.id,
      module_id: Number.isInteger(q.unit) ? unitIds[q.unit] || null : null, topic: text(q.topic, 120),
      question_text: text(q.question_text, 4000), options: options(q.options, `${j + 1} of the bank`),
      explanation: text(q.explanation, 2000), image_url: text(q.image_url, 500) })).filter(q => q.question_text);
    if (bankRows.length) {
      const { error } = await admin.from('question_bank').upsert(bankRows, { onConflict: 'teacher_id,text_key', ignoreDuplicates: true });
      if (error) throw new Error('bank: ' + error.message);
    }
    report.bank = bankRows.length;
  } catch (err) {
    console.error('course import failed:', err);
    await admin.from('courses').delete().eq('id', course.id);
    throw err instanceof HttpError ? err : new HttpError(500, `The import could not be finished, so it was removed: ${err.message}`);
  }

  await logActivity(teacherId, profile, 'course_imported',
    `${title} · ${report.units} units, ${report.lessons} lessons, ${report.tests} tests, ${report.questions} questions`);
  return { ...report, lessonIds };
}

export async function importFile(profile, body) {
  const teacherId = teacherOf(profile, body);
  if (!r2Ready().ready) throw new HttpError(503, 'File storage is not set up yet.');
  const lessonId = String(body.lesson_id || '');
  if (!lessonId) throw new HttpError(400, 'Which lesson?');
  await assertTenant('lessons', lessonId, teacherId);
  const title = text(body.title, 200) || 'File';
  const { body: bytes, type } = await fetchAllowed(body.url);
  const key = `${teacherId}/lessons/${lessonId}/${Date.now()}-${safeName(body.name || title + '.pdf')}`;
  await putObject(PRIVATE(), key, bytes, type);
  const kind = ['pdf', 'sheet'].includes(body.kind) ? body.kind : 'pdf';
  const { data, error } = await admin.from('lesson_materials').insert({
    teacher_id: teacherId, lesson_id: lessonId, title, kind, file_url: R2_FILE + key, file_size: bytes.length,
  }).select('id').single();
  if (error) throw new HttpError(500, 'The file was stored but could not be added to the lesson.');
  return { material_id: data.id, size: bytes.length };
}

export async function importPicture(profile, body) {
  const teacherId = teacherOf(profile, body);
  if (!r2Ready().ready) throw new HttpError(503, 'File storage is not set up yet.');
  const { body: bytes, type } = await fetchAllowed(body.url, { image: true });
  const name = safeName(new URL(body.url).pathname.split('/').pop(), 'picture');
  const key = `${teacherId}/questions/${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${name}`;
  await putObject(PUBLIC(), key, bytes, type);
  return { public_url: publicUrl(key) };
}
