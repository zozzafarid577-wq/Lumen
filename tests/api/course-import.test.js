import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, configureSupabaseMock, getSupabaseCalls, PROFILES } from '../helpers/supabase-mock.js';
import { importCourse, importFile, importPicture } from '../../api/_lib/import.js';

const TEACHER = { ...PROFILES['teacher-uid'] };
const R2 = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'lumen-files', R2_PUBLIC_BUCKET: 'lumen-public', R2_PUBLIC_URL: 'https://pub-test.r2.dev' };

let requests;
beforeEach(() => {
  resetSupabaseMock();
  Object.assign(process.env, R2);
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (req, init) => {
    const url = typeof req === 'string' ? req : req.url;
    requests.push({ url: String(url), method: init?.method || req?.method || 'GET' });
    const isPic = String(url).includes('.png');
    return new Response('bytes', { status: 200, headers: { 'content-type': isPic ? 'image/png' : 'application/pdf' } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of Object.keys(R2)) delete process.env[k]; });

const echo = (call) => ({ data: (Array.isArray(call.payload) ? call.payload : [call.payload]).map((r, i) => ({ id: r.id || `new-${i}`, ...r })), error: null });
const inserted = (table) => getSupabaseCalls().filter(c => c.table === table && c.op === 'insert').flatMap(c => [].concat(c.payload));

describe('bringing a course in from another site', () => {
  it('builds units, lessons and tests, and links each test to its unit and lesson', async () => {
    configureSupabaseMock({ results: {
      'courses.insert': { data: { id: 'c-new' }, error: null },
      'modules.insert': echo, 'lessons.insert': echo, 'practice_tests.insert': echo, 'test_questions.insert': echo,
    } });
    const out = await importCourse(TEACHER, {
      course: { title: 'ACT/EST Biology Basics', subject: 'Biology' },
      units: [{ title: 'Ecology', lessons: [{ key: 'm-1', title: 'Ecology' }] }],
      tests: [{ title: 'Ecology 1', unit: 0, lesson_key: 'm-1', questions: [
        { question_text: 'Which is a producer?', options: [{ text: 'Grass', correct: true }, { text: 'Hawk' }] },
      ] }, { title: 'Mock test 1', unit: null, questions: [
        { question_text: 'Q', options: [{ text: 'a' }, { text: 'b', correct: true }] },
      ] }],
    });
    expect(out).toMatchObject({ course_id: 'c-new', units: 1, lessons: 1, tests: 2, questions: 2 });
    const [unit] = inserted('modules');
    const [lesson] = inserted('lessons');
    const [ecology, mock] = inserted('practice_tests');
    expect(lesson.module_id).toBe(unit.id);
    expect(out.lessonIds['m-1']).toBe(lesson.id);
    expect(ecology).toMatchObject({ module_id: unit.id, lesson_id: lesson.id, teacher_id: 'teacher-1' });
    expect(mock).toMatchObject({ module_id: null, lesson_id: null });
    expect(inserted('test_questions').map(q => q.test_id)).toEqual([ecology.id, mock.id]);
  });

  it('removes the course again when a question is broken, and says which', async () => {
    configureSupabaseMock({ results: {
      'courses.insert': { data: { id: 'c-new' }, error: null },
      'modules.insert': echo, 'lessons.insert': echo,
    } });
    await expect(importCourse(TEACHER, {
      course: { title: 'Bio' }, units: [],
      tests: [{ title: 'Quiz', questions: [{ question_text: 'Q', options: [{ text: 'a' }, { text: 'b' }] }] }],
    })).rejects.toThrow(/Quiz/);
    expect(getSupabaseCalls().some(c => c.table === 'courses' && c.op === 'delete')).toBe(true);
  });
});

describe('bringing files in', () => {
  it('stores a PDF on the private bucket and adds it to the lesson', async () => {
    configureSupabaseMock({ results: {
      'lessons.select': { data: { id: 'l-1', teacher_id: 'teacher-1' }, error: null },
      'lesson_materials.insert': { data: { id: 'mat-1' }, error: null },
    } });
    const out = await importFile(TEACHER, { lesson_id: 'l-1', title: 'Ecology Lesson PDF', url: 'https://acct2.r2.cloudflarestorage.com/lesson-media/pdfs/eco.pdf?X-Amz-Signature=x' });
    expect(out.material_id).toBe('mat-1');
    const put = requests.find(r => r.method === 'PUT');
    expect(put.url).toMatch(/lumen-files\/teacher-1\/lessons\/l-1\//);
    expect(inserted('lesson_materials')[0].file_url).toMatch(/^r2:teacher-1\/lessons\/l-1\//);
  });

  it('will not fetch from just any address', async () => {
    configureSupabaseMock({ results: { 'lessons.select': { data: { id: 'l-1', teacher_id: 'teacher-1' }, error: null } } });
    await expect(importFile(TEACHER, { lesson_id: 'l-1', url: 'https://169.254.169.254/latest/meta-data' })).rejects.toThrow(/Cloudflare R2 or Supabase/);
    await expect(importPicture(TEACHER, { url: 'http://x.supabase.co/a.png' })).rejects.toThrow(/Cloudflare R2 or Supabase/);
    expect(requests).toHaveLength(0);
  });

  it('stores a picture on the public bucket and hands back its address', async () => {
    const out = await importPicture(TEACHER, { url: 'https://old.supabase.co/storage/v1/object/public/q/fig.png' });
    expect(out.public_url).toMatch(/^https:\/\/pub-test\.r2\.dev\/teacher-1\/questions\/.*fig\.png$/);
  });
});
