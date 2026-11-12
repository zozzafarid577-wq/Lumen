import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

import { levelFor, settingsOf, weekStart, unitBreakdown, periodFor } from '../../api/_lib/parent-reports.js';
import { dailyEvaluation, weeklyReport } from '../../api/_lib/email.js';

describe('how a unit is judged', () => {
  it('sorts marks into strong, getting there and needs work', () => {
    expect(levelFor(75)).toBe('strong');
    expect(levelFor(74)).toBe('getting');
    expect(levelFor(60)).toBe('getting');
    expect(levelFor(59)).toBe('weak');
  });

  it('counts each test once, at the best attempt', () => {
    const tests = new Map([['t1', { module_id: 'u1' }], ['t2', { module_id: 'u1' }], ['t3', { module_id: 'u2' }]]);
    const modules = new Map([['u1', { title: 'Genetics', order_index: 1 }], ['u2', { title: 'Ecology', order_index: 0 }]]);
    const units = unitBreakdown([
      { test_id: 't1', percentage: '40' }, { test_id: 't1', percentage: '90' },
      { test_id: 't2', percentage: '50' },
      { test_id: 't3', percentage: '80' },
    ], tests, modules);
    expect(units).toEqual([
      expect.objectContaining({ title: 'Ecology', pct: 80, level: 'strong' }),
      expect.objectContaining({ title: 'Genetics', pct: 70, level: 'getting', tests: 2 }),
    ]);
  });

  it('leaves out tests that sit in no unit', () => {
    const units = unitBreakdown([{ test_id: 't9', percentage: '30' }], new Map([['t9', { module_id: null }]]), new Map());
    expect(units).toEqual([]);
  });
});

describe('the teacher’s settings', () => {
  it('sends nothing until a teacher turns it on', () => {
    expect(settingsOf({ parent_reports: {} })).toEqual({ daily: false, weekly: false, weeklyDay: 6 });
  });

  it('starts the report week on the teacher’s day', () => {
    // 2026-11-12 is a Thursday (dow 4); a Saturday week began on the 7th.
    expect(weekStart({ iso: '2026-11-12', dow: 4 }, 6)).toBe('2026-11-07');
    expect(weekStart({ iso: '2026-11-14', dow: 6 }, 6)).toBe('2026-11-14');
  });
});

describe('one child’s day', () => {
  const from = new Date('2026-11-11T00:00:00Z'), until = new Date('2026-11-12T00:00:00Z');
  const space = {
    attempts: new Map([['s1', [
      { test_id: 't1', score: 18, max_score: 20, percentage: '90', passed: true, completed_at: '2026-11-11T10:00:00Z' },
      { test_id: 't1', score: 5, max_score: 20, percentage: '25', passed: false, completed_at: '2026-11-09T10:00:00Z' },
    ]]]),
    lessons: new Map([['s1', [{ completed_at: '2026-11-11T09:00:00Z' }]]]),
    courses: new Map([['s1', new Set(['c1'])]]),
    homework: [
      { id: 'h1', title: 'Worksheet 3', course_id: 'c1', due_at: '2026-11-11T20:00:00Z' },
      { id: 'h2', title: 'Worksheet 4', course_id: 'c1', due_at: '2026-11-11T21:00:00Z' },
      { id: 'h3', title: 'Other course', course_id: 'c2', due_at: '2026-11-11T21:00:00Z' },
    ],
    handedIn: new Set(['h1:s1']),
    tests: new Map([['t1', { title: 'Unit 1 quiz' }]]),
  };

  it('keeps only what happened that day, and only homework from their courses', () => {
    const day = periodFor(space, { id: 's1' }, from, until);
    expect(day.tests).toEqual([expect.objectContaining({ title: 'Unit 1 quiz', score: 18, maxScore: 20 })]);
    expect(day.lessons).toBe(1);
    expect(day.homeworkDue).toBe(2);
    expect(day.homeworkDone).toBe(1);
    expect(day.missed).toEqual(['Worksheet 4']);
  });
});

describe('the emails', () => {
  it('the daily evaluation names the marks and the missed homework', () => {
    const mail = dailyEvaluation({ studentName: 'Sara', spaceName: 'Dr Mai', dayLabel: 'Wednesday 11 November',
      tests: [{ title: 'Unit 1 quiz', score: 18, maxScore: 20, passed: true }], lessons: 1, homeworkDue: 2, homeworkDone: 1, missed: ['Worksheet 4'] });
    expect(mail.subject).toContain('Sara');
    expect(mail.html).toContain('18/20');
    expect(mail.html).toContain('Worksheet 4');
    expect(mail.html).toContain('dir="rtl"');
  });

  it('the weekly report puts the weakest unit first and names it as the focus', () => {
    const mail = weeklyReport({ studentName: 'Sara', spaceName: 'Dr Mai', weekLabel: '1 – 7 November',
      week: { tests: 3, average: 72, lessons: 4, homeworkDue: 0, homeworkDone: 0, missed: [] },
      units: [{ title: 'Ecology', pct: 88, level: 'strong' }, { title: 'Genetics', pct: 48, level: 'weak' }] });
    expect(mail.html.indexOf('Genetics')).toBeLessThan(mail.html.indexOf('Ecology'));
    expect(mail.html).toMatch(/Focus for next week:<\/strong> Genetics/);
    expect(mail.html).toContain('محتاج تركيز');
  });
});
