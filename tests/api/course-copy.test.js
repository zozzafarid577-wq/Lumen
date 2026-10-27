import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, configureSupabaseMock, getSupabaseCalls, PROFILES } from '../helpers/supabase-mock.js';
import { copyCourse } from '../../api/_lib/course-copy.js';
import { lessonUploadLink, deleteLessonFiles, publicUploadLink } from '../../api/_lib/files.js';

const TEACHER = { ...PROFILES['teacher-uid'] };
const R2 = { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'lumen-files', R2_PUBLIC_BUCKET: 'lumen-public', R2_PUBLIC_URL: 'https://pub-test.r2.dev' };

let r2Requests;
beforeEach(() => {
  resetSupabaseMock();
  Object.assign(process.env, R2);
  r2Requests = [];
  vi.stubGlobal('fetch', vi.fn(async (req, init) => {
    const url = typeof req === 'string' ? req : req.url;
    const method = init?.method || req.method;
    const headers = new Headers(init?.headers || req.headers);
    r2Requests.push({ url, method, copySource: headers.get('x-amz-copy-source') });
    return new Response('', { status: 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of Object.keys(R2)) delete process.env[k]; });

// Inserts hand back the rows they were given, as the database would.
const echo = (call) => ({ data: (Array.isArray(call.payload) ? call.payload : [call.payload]).map((r, i) => ({ id: r.id || `new-${i}`, ...r })), error: null });

function world() {
  configureSupabaseMock({ results: {
    'courses.select': [
      { data: { id: 'c-1', teacher_id: 'teacher-1' }, error: null },                       // assertTenant
      { data: { id: 'c-1', teacher_id: 'teacher-1', title: 'Senior 2', subject: 'English', is_active: true }, error: null },
    ],
    'modules.select': { data: [{ id: 'm-1', title: 'Unit 1', is_done: true, open_at: '2026-09-01T00:00:00Z', order_index: 0 }], error: null },
    'lessons.select': { data: [{ id: 'l-1', module_id: 'm-1', title: 'Lesson 1', video_url: 'https://youtu.be/abc', duration_min: 45, order_index: 0 }], error: null },
    'lesson_materials.select': { data: [
      { id: 'mat-1', lesson_id: 'l-1', title: 'Worksheet', kind: 'pdf', file_url: 'r2:teacher-1/lessons/l-1/111-worksheet.pdf', file_size: 1000 },
      { id: 'mat-2', lesson_id: 'l-1', title: 'Grammar notes', kind: 'link', file_url: 'https://drive.google.com/file/d/x' },
      { id: 'mat-3', lesson_id: 'l-1', title: 'Class video', kind: 'link', file_url: 'https://www.youtube.com/watch?v=1' },
    ], error: null },
    'practice_tests.select': [
      { data: [
        { id: 't-1', module_id: 'm-1', lesson_id: 'l-1', title: 'Lesson 1 Vocabulary', passing_score_pct: 60, is_active: true, order_index: 0, open_at: '2026-09-02T00:00:00Z', is_offline: false },
        { id: 't-2', module_id: 'm-1', title: 'Paper quiz', is_offline: true },
      ], error: null },
      { data: null, error: null, count: 1 },
    ],
    'test_questions.select': { data: [
      { id: 'q-1', test_id: 't-1', question_text: 'Pick one', options: [{ text: 'a', correct: true }, { text: 'b' }], explanation: 'Because.', image_url: 'https://pub-test.r2.dev/teacher-1/questions/fig.png', order_index: 0, points: 1 },
    ], error: null },
    'courses.insert': { data: { id: 'c-new' }, error: null },
    'modules.insert': echo, 'lessons.insert': echo, 'lesson_materials.insert': echo,
    'practice_tests.insert': echo, 'test_questions.insert': echo,
  } });
}

describe('copying a course for a new batch', () => {
  it('brings the material and leaves the old batch and the recordings behind', async () => {
    world();
    const out = await copyCourse(TEACHER, { course_id: 'c-1', title: 'Senior 2 — 2027' });
    expect(out).toMatchObject({ title: 'Senior 2 — 2027', units: 1, lessons: 1, files: 1, links: 1, tests: 1, questions: 1, skipped: { recordings: 1, paperTests: 1 }, failed: [] });

    const [unit] = getSupabaseCalls('modules.insert')[0].payload;
    expect(unit).toMatchObject({ course_id: 'c-new', is_done: false, open_at: null });
    const [lesson] = getSupabaseCalls('lessons.insert')[0].payload;
    expect(lesson).toMatchObject({ module_id: unit.id, video_url: null, duration_min: null });

    const mats = getSupabaseCalls('lesson_materials.insert')[0].payload;
    expect(mats.map(m => m.title)).toEqual(['Worksheet', 'Grammar notes']);
    expect(mats[0].file_url).toMatch(new RegExp(`^r2:teacher-1/lessons/${lesson.id}/`));
    expect(r2Requests).toEqual([expect.objectContaining({ method: 'PUT', copySource: '/lumen-files/teacher-1/lessons/l-1/111-worksheet.pdf' })]);

    const [test] = getSupabaseCalls('practice_tests.insert')[0].payload;
    expect(test).toMatchObject({ course_id: 'c-new', module_id: unit.id, lesson_id: lesson.id, open_at: null, title: 'Lesson 1 Vocabulary' });
    const [q] = getSupabaseCalls('test_questions.insert')[0].payload;
    expect(q).toMatchObject({ test_id: test.id, explanation: 'Because.', image_url: 'https://pub-test.r2.dev/teacher-1/questions/fig.png' });

    // Nothing about students is so much as read.
    for (const t of ['enrollments', 'groups', 'test_attempts', 'test_assignments', 'messages']) {
      expect(getSupabaseCalls(`${t}.select`)).toHaveLength(0);
    }
  });

  it('takes a half-made copy away again', async () => {
    world();
    configureSupabaseMock({ results: { 'test_questions.insert': { data: null, error: { message: 'boom' } } } });
    await expect(copyCourse(TEACHER, { course_id: 'c-1' })).rejects.toThrow(/removed/);
    expect(getSupabaseCalls('courses.delete')[0].filters).toEqual({ id: 'c-new' });
  });

  it('needs the courses permission', async () => {
    const assistant = { ...PROFILES['assistant-uid'], staff_perms: ['students'] };
    await expect(copyCourse(assistant, { course_id: 'c-1' })).rejects.toThrow(/not given you access/);
  });
});

describe('files on Cloudflare R2', () => {
  it('signs an upload into the space’s own folder only', async () => {
    configureSupabaseMock({ results: { 'lessons.select': { data: { id: 'l-1', teacher_id: 'teacher-1' }, error: null } } });
    const out = await lessonUploadLink(TEACHER, { lesson_id: 'l-1', name: 'Week 1 worksheet.pdf', size: 1000 });
    expect(out.key).toMatch(/^teacher-1\/lessons\/l-1\/\d+-Week-1-worksheet\.pdf$/);
    expect(out.file_url).toBe('r2:' + out.key);
    expect(out.url).toContain('https://acct.r2.cloudflarestorage.com/lumen-files/teacher-1/lessons/l-1/');
    expect(out.url).toContain('X-Amz-Signature=');
  });

  it('refuses a lesson from another space', async () => {
    configureSupabaseMock({ results: { 'lessons.select': { data: { id: 'l-9', teacher_id: 'teacher-2' }, error: null } } });
    await expect(lessonUploadLink(TEACHER, { lesson_id: 'l-9', name: 'x.pdf' })).rejects.toThrow(/another teacher/);
  });

  it('never deletes outside the caller’s folder', async () => {
    await expect(deleteLessonFiles(TEACHER, { keys: ['teacher-2/lessons/l-1/a.pdf'] })).rejects.toThrow(/another space/);
    await expect(deleteLessonFiles(TEACHER, { keys: ['teacher-1/../teacher-2/a.pdf'] })).rejects.toThrow(/another space/);
    expect(r2Requests).toHaveLength(0);
  });

  it('puts a logo in the public bucket and says where students read it', async () => {
    const out = await publicUploadLink(TEACHER, { purpose: 'branding', name: 'logo.png', type: 'image/png', size: 2000 });
    expect(out.public_url).toMatch(/^https:\/\/pub-test\.r2\.dev\/teacher-1\/branding\/\d+-logo\.png$/);
    await expect(publicUploadLink(TEACHER, { purpose: 'branding', name: 'x.pdf', type: 'application/pdf' })).rejects.toThrow(/Only pictures/);
  });

  it('lets uploads carry on to Supabase until R2 is set up', async () => {
    delete process.env.R2_BUCKET;
    expect(await lessonUploadLink(TEACHER, { lesson_id: 'l-1' })).toEqual({ r2: false });
    expect(await publicUploadLink(TEACHER, { purpose: 'branding', type: 'image/png' })).toEqual({ r2: false });
    await expect(deleteLessonFiles(TEACHER, { keys: [] })).rejects.toThrow(/not set up yet \(R2_BUCKET\)/);
  });
});
