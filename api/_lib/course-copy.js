import { admin } from './supabase.js';
import { HttpError, requireRoles, requirePerm, assertTenant, logActivity } from './auth.js';
import { randomUUID } from 'node:crypto';
import { PRIVATE, copyObject, putObject, safeName, r2Ready } from './r2.js';
import { R2_FILE, SUPABASE_FILE } from './files.js';

// A copy of a course for a new batch of students, in the same space.
//
// What a new batch needs is the material, not the old batch: every unit
// and lesson (titles, descriptions, order), every PDF and worksheet, and
// every test with its questions, answers, explanations and pictures.
// Nothing about the old students comes along — no enrolments, groups,
// marks, attempts, deadlines or messages — and no recordings: those are
// filmed for each batch.
//
// The copy's units start NOT ready, so nothing in it reaches a student
// until the teacher releases it, one unit at a time, as before.
//
// Uploaded files are copied inside Cloudflare R2, so deleting a file from
// one course never takes it from the other. A file still in Supabase
// storage is copied onto R2 on the way. Question pictures are public and
// never change, so the copy points at the same picture.

const VIDEO = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com)$/i;
const isRecording = (m) => m.kind === 'recording'
  || (() => { try { return VIDEO.test(new URL(m.file_url).hostname); } catch (_) { return false; } })();

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

async function insertAll(table, rows, select = 'id') {
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await admin.from(table).insert(rows.slice(i, i + 500)).select(select);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
  }
  return out;
}

export async function copyCourse(profile, body) {
  requireRoles(profile, ['teacher', 'assistant']);
  requirePerm(profile, 'courses');
  const teacherId = profile.teacher_id;
  const courseId = String(body.course_id || '');
  if (!courseId) throw new HttpError(400, 'Which course?');
  await assertTenant('courses', courseId, teacherId);

  const { data: course } = await admin.from('courses').select('*').eq('id', courseId).single();
  const title = String(body.title || '').trim().slice(0, 120) || `${course.title} (copy)`;

  const units = await everyRow(() => admin.from('modules').select('*').eq('course_id', courseId));
  const unitIds = units.map(u => u.id);
  const lessons = unitIds.length ? await everyRow(() => admin.from('lessons').select('*').in('module_id', unitIds)) : [];
  const lessonIds = lessons.map(l => l.id);
  const materials = [];
  for (let i = 0; i < lessonIds.length; i += 100) {
    materials.push(...await everyRow(() => admin.from('lesson_materials').select('*').in('lesson_id', lessonIds.slice(i, i + 100))));
  }
  const tests = (await everyRow(() => admin.from('practice_tests').select('*').eq('course_id', courseId)))
    .filter(t => !t.is_offline);   // marks typed in from paper belong to the old batch
  const questions = [];
  for (let i = 0; i < tests.length; i += 100) {
    questions.push(...await everyRow(() => admin.from('test_questions').select('*').in('test_id', tests.slice(i, i + 100).map(t => t.id))));
  }

  if (materials.some(m => !isRecording(m) && /^(r2:|lumen-file:)/.test(m.file_url)) && !r2Ready().ready) {
    throw new HttpError(503, 'File storage is not set up yet, so the PDFs cannot be copied.');
  }

  // The course itself, at the top of the list.
  const { data: copy, error: cErr } = await admin.from('courses').insert({
    teacher_id: teacherId, title, subject: course.subject, description: course.description,
    thumbnail_url: course.thumbnail_url, exam_date: null, is_active: course.is_active, order_index: -1,
  }).select('id').single();
  if (cErr) throw new HttpError(500, 'Could not create the copy.');

  const report = { course_id: copy.id, title, units: 0, lessons: 0, files: 0, links: 0, tests: 0, questions: 0, skipped: { recordings: 0, paperTests: 0 }, failed: [] };
  report.skipped.paperTests = (await admin.from('practice_tests').select('id', { count: 'exact', head: true }).eq('course_id', courseId).eq('is_offline', true)).count || 0;

  try {
    // Ids are chosen here, so each copy is matched to its original by
    // construction rather than by the order rows come back in.
    const unitMap = new Map(units.map(u => [u.id, randomUUID()]));
    const newUnits = await insertAll('modules', units.map(u => ({
      id: unitMap.get(u.id), teacher_id: teacherId, course_id: copy.id, title: u.title, description: u.description,
      is_done: false, open_at: null, order_index: u.order_index,
    })));
    report.units = newUnits.length;

    const lessonMap = new Map(lessons.map(l => [l.id, randomUUID()]));
    const newLessons = await insertAll('lessons', lessons.map(l => ({
      id: lessonMap.get(l.id), teacher_id: teacherId, module_id: unitMap.get(l.module_id), title: l.title,
      description: l.description, video_url: null, duration_min: null, order_index: l.order_index,
    })));
    report.lessons = newLessons.length;

    const matRows = [];
    for (const m of materials) {
      if (isRecording(m)) { report.skipped.recordings++; continue; }
      const lessonId = lessonMap.get(m.lesson_id);
      let fileUrl = m.file_url;
      try {
        if (fileUrl.startsWith(R2_FILE) || fileUrl.startsWith(SUPABASE_FILE)) {
          const old = fileUrl.startsWith(R2_FILE) ? fileUrl.slice(R2_FILE.length) : fileUrl.slice(SUPABASE_FILE.length);
          const key = `${teacherId}/lessons/${lessonId}/${Date.now()}-${safeName(old.split('/').pop())}`;
          if (fileUrl.startsWith(R2_FILE)) await copyObject(PRIVATE(), old, PRIVATE(), key);
          else {
            const { data: blob, error } = await admin.storage.from('lesson-media').download(old);
            if (error || !blob) throw new Error(error?.message || 'not found');
            await putObject(PRIVATE(), key, Buffer.from(await blob.arrayBuffer()), blob.type || undefined);
          }
          fileUrl = R2_FILE + key;
          report.files++;
        } else report.links++;
        matRows.push({ teacher_id: teacherId, lesson_id: lessonId, title: m.title, kind: m.kind, file_url: fileUrl, file_size: m.file_size });
      } catch (err) { report.failed.push(`${m.title}: ${err.message}`); }
    }
    if (matRows.length) await insertAll('lesson_materials', matRows);

    const testMap = new Map(tests.map(t => [t.id, randomUUID()]));
    const newTests = await insertAll('practice_tests', tests.map(t => ({
      id: testMap.get(t.id), teacher_id: teacherId, course_id: copy.id,
      module_id: t.module_id ? unitMap.get(t.module_id) || null : null,
      lesson_id: t.lesson_id ? lessonMap.get(t.lesson_id) || null : null,
      section_id: t.section_id, title: t.title, description: t.description,
      time_limit_min: t.time_limit_min, passing_score_pct: t.passing_score_pct, max_attempts: t.max_attempts,
      open_at: null, close_at: null, is_active: t.is_active, order_index: t.order_index,
    })));
    report.tests = newTests.length;

    const newQs = await insertAll('test_questions', questions.map(q => ({
      teacher_id: teacherId, test_id: testMap.get(q.test_id), question_text: q.question_text,
      options: q.options, explanation: q.explanation, image_url: q.image_url,
      order_index: q.order_index, points: q.points,
    })));
    report.questions = newQs.length;
  } catch (err) {
    // A half-made copy is worse than none: take it away (its rows go with
    // the course) and say what stopped it.
    console.error('course copy failed:', err);
    await admin.from('courses').delete().eq('id', copy.id);
    throw new HttpError(500, `The copy could not be finished, so it was removed: ${err.message}`);
  }

  await logActivity(teacherId, profile, 'course_copied',
    `${course.title} → ${title} · ${report.units} units, ${report.lessons} lessons, ${report.files + report.links} materials, ${report.tests} tests, ${report.questions} questions`);
  return report;
}
