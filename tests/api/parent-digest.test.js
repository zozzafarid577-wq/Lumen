import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { resetSupabaseMock, configureSupabaseMock, getSupabaseCalls } from '../helpers/supabase-mock.js';
import { parentResults, digestEmail, runParentDigest } from '../../api/_lib/parent-digest.js';

beforeEach(() => resetSupabaseMock());

const ROW = (name, score, passed, course = 'Senior 2') => ({
  id: name, score, max_score: 20, percentage: score * 5, passed, parent_emailed_at: '2026-10-21T10:00:00Z',
  profiles: { full_name: name, parent_email: `${name.toLowerCase()}@parents.example` },
  practice_tests: { title: 'Unit 1 - Lesson 1', courses: { title: course } },
});

describe('the results sent to parents', () => {
  it('lists each one as student, test and mark, course by course', async () => {
    configureSupabaseMock({ results: { 'test_attempts.select': { data: [ROW('Belal', 9, false), ROW('Amira', 18, true), ROW('Omar', 15, true, 'Senior 1')], error: null } } });
    const rows = await parentResults('teacher-1', new Date(0), new Date());
    expect(rows.map(r => [r.course, r.student, r.mark])).toEqual([
      ['Senior 1', 'Omar', '15/20'], ['Senior 2', 'Amira', '18/20'], ['Senior 2', 'Belal', '9/20'],
    ]);
    const html = digestEmail({ dayLabel: 'Wednesday 21 October', rows });
    expect(html).toContain('belal@parents.example');
    expect(html).toContain('Below the pass mark');
  });

  it('goes to the teacher and every assistant on the groups, once a day', async () => {
    process.env.BREVO_API_KEY = '';
    configureSupabaseMock({ results: {
      'test_attempts.select': { data: [ROW('Amira', 18, true)], error: null },
      'groups.select': { data: [{ teacher_name: 'Mrs. Abeer', teacher_email: 'abeer@example.com, mariam@example.com' }], error: null },
    } });
    const out = await runParentDigest(new Date('2026-10-22T05:00:00Z'), { onlyTeacher: 'teacher-1' });
    expect(out.teachers[0].sent.map(s => s.to)).toEqual(['abeer@example.com', 'mariam@example.com']);
    expect(getSupabaseCalls('notify_log.insert')[0]).toBeTruthy();
  });
});
