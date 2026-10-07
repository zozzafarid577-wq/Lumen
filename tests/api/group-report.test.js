import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import ExcelJS from 'exceljs';
import { resetSupabaseMock, configureSupabaseMock, getSupabaseCalls } from '../helpers/supabase-mock.js';
import { buildReport, cairoDay, daysSinceLastSession, runGroupReports } from '../../api/_lib/group-report.js';

beforeEach(() => resetSupabaseMock());

const GROUP = { id: 'g-1', name: 'Sunday 4pm', days: [0, 3], start_time: '16:00:00', course_id: 'c-1', teacher_id: 'teacher-1', courses: { title: 'Senior 2' } };

describe('when a group last met', () => {
  it('looks back to the group’s previous day, not always a week', () => {
    // Meets Sunday (0) and Wednesday (3): the Wednesday class reaches back to Sunday.
    expect(daysSinceLastSession([0, 3], 3)).toBe(3);
    // and the Sunday class back to Wednesday.
    expect(daysSinceLastSession([0, 3], 0)).toBe(4);
    // A once-a-week group gets the whole week.
    expect(daysSinceLastSession([5], 5)).toBe(7);
  });

  it('reads the day in Egypt, not in UTC', () => {
    // 23:30 UTC on a Saturday is already Sunday morning in Cairo.
    expect(cairoDay(new Date('2026-10-10T23:30:00Z'))).toEqual({ iso: '2026-10-11', dow: 0 });
  });
});

function world({ attempts }) {
  configureSupabaseMock({
    results: {
      'enrollments.select': { data: [
        { student_id: 's-1', profiles: { full_name: 'Amira', is_active: true } },
        { student_id: 's-2', profiles: { full_name: 'Belal', is_active: true } },
      ], error: null },
      'test_attempts.select': { data: attempts, error: null },
    },
  });
}

describe('the marks sheet', () => {
  it('has a row per student, a column per test, and each student’s best mark', async () => {
    world({ attempts: [
      { student_id: 's-1', test_id: 't-1', score: 12, max_score: 20, percentage: 60, passed: true, completed_at: '2026-10-05T10:00:00Z', practice_tests: { title: 'Unit 1 - Lesson 1', course_id: 'c-1', test_sections: { name: 'Vocabulary' } } },
      { student_id: 's-1', test_id: 't-1', score: 18, max_score: 20, percentage: 90, passed: true, completed_at: '2026-10-06T10:00:00Z', practice_tests: { title: 'Unit 1 - Lesson 1', course_id: 'c-1', test_sections: { name: 'Vocabulary' } } },
      { student_id: 's-1', test_id: 't-2', score: 7, max_score: 10, percentage: 70, passed: true, completed_at: '2026-10-06T11:00:00Z', practice_tests: { title: 'Paper quiz', course_id: 'c-1', is_offline: true } },
      // Another course's test: not this group's business.
      { student_id: 's-2', test_id: 't-9', score: 1, max_score: 1, percentage: 100, passed: true, completed_at: '2026-10-06T11:00:00Z', practice_tests: { title: 'Elsewhere', course_id: 'c-9' } },
    ] });

    const r = await buildReport(GROUP, new Date('2026-10-04T00:00:00Z'), new Date('2026-10-07T00:00:00Z'));
    expect(r).toMatchObject({ students: 2, tests: 2, attempts: 3, nobody: ['Belal'] });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(r.base64, 'base64'));
    const rows = wb.getWorksheet('Marks').getSheetValues().filter(Boolean).map(v => v.slice(1));
    expect(rows[0]).toEqual(['Student', 'Unit 1 - Lesson 1 (Vocabulary)', 'Paper quiz — in class', 'Tests done']);
    expect(rows[1]).toEqual(['Amira', '18/20', '7/10', 2]);
    expect(rows[2]).toEqual(['Belal', '—', '—', 0]);
  });
});

describe('the morning run', () => {
  it('sends nothing twice for the same group and day', async () => {
    configureSupabaseMock({
      results: {
        'groups.select': { data: [{ ...GROUP, days: [0] }], error: null },
        // The key is already there: this morning's report went out.
        'notify_log.insert': { data: null, error: { message: 'duplicate key' } },
      },
    });
    // Saturday in Cairo, so the Sunday group meets tomorrow.
    const out = await runGroupReports(new Date('2026-10-10T05:00:00Z'));
    expect(out).toEqual({ groups: 1, sent: 0 });
    expect(getSupabaseCalls('enrollments.select')).toHaveLength(0);
  });

  it('only looks at groups that meet tomorrow', async () => {
    configureSupabaseMock({
      results: {
        'groups.select': { data: [{ ...GROUP, days: [2] }], error: null },
      },
    });
    const out = await runGroupReports(new Date('2026-10-10T05:00:00Z'));
    expect(out).toEqual({ groups: 0, sent: 0 });
  });
});

describe('the trial send', () => {
  it('goes only to the inbox it is given, and records nothing', async () => {
    const { runGroupReportTest } = await import('../../api/_lib/group-report.js');
    configureSupabaseMock({
      results: {
        'groups.select': { data: [{ ...GROUP, days: [0] }], error: null },
        'enrollments.select': { data: [], error: null },
      },
    });
    const out = await runGroupReportTest('teacher-1', 'lumen@example.com', new Date('2026-10-10T05:00:00Z'));
    expect(out.to).toBe('lumen@example.com');
    expect(out.groups).toHaveLength(1);
    expect(getSupabaseCalls('notify_log.insert')).toHaveLength(0);
  });
});
