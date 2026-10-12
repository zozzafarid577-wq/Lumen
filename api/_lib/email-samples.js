import {
  sendEmail, studentInvite, accountReady, progressReport, teacherWelcome, signInEmailChanged,
} from './email.js';

// One of every kind of email Lumen sends, filled with made-up details,
// to Lumen's own inbox — for checking how they look and that each one
// arrives with its PDF. Nothing here reaches a student, parent or teacher.
export async function sendEmailSamples(inbox, { spaceName = 'Lumen', site = 'https://lumenlearn.site' } = {}) {
  const { resultEmail } = await import('../result-email.js');
  const { supportEmail } = await import('../support.js');
  const login = site + '/login.html';

  const samples = [
    ['Student welcome (set-up link)', studentInvite({ name: 'Sample Student', email: 'student@example.com', spaceName, setupUrl: site + '/setup/SAMPLE', kind: 'welcome' })],
    ['Student new set-up link', studentInvite({ name: 'Sample Student', email: 'student@example.com', spaceName, setupUrl: site + '/setup/SAMPLE', kind: 'reset' })],
    ['Account ready', accountReady({ name: 'Sample Student', email: 'student@example.com', password: 'sample-only', spaceName, loginUrl: login })],
    ['Parent progress report', progressReport({
      studentName: 'Sample Student', spaceName, teacherEmail: 'teacher@example.com',
      stats: { testsTaken: 7, totalScore: 152, totalMax: 190, bestScore: 33, bestMax: 33, lessonsDone: 9, lessonsTotal: 12 },
      recent: [{ title: 'Unit 2 - Lesson 1', score: 29, maxScore: 33, passed: true }, { title: 'Unit 2 - Lesson 2', score: 14, maxScore: 37, passed: false }],
    })],
    ['Test result to a parent', {
      subject: 'Sample Student — Unit 2 - Lesson 1 — 29/33',
      html: resultEmail({ student: 'Sample Student', test: 'Unit 2 - Lesson 1', shown: '29/33', score: 29, maxScore: 33, passed: true, passMark: 60, space: spaceName, when: new Date().toISOString() }),
    }],
    ['Teacher welcome', teacherWelcome({ name: 'Sample Teacher', email: 'teacher@example.com', password: 'sample-only', spaceName, loginUrl: login })],
    ['Sign-in email changed', signInEmailChanged({ name: 'Sample Student', oldEmail: 'old@example.com', newEmail: 'new@example.com', spaceName, loginUrl: login })],
    ['Help request from a student', {
      subject: 'Lumen help — Something is broken — Sample Student',
      html: supportEmail({ name: 'Sample Student', from: 'student@example.com', kind: 'Something is broken', message: 'The video in Unit 2 Lesson 1 will not play on my phone.', role: 'student' }),
    }],
  ];

  const out = [];
  for (const [label, mail] of samples) {
    const res = await sendEmail({ to: inbox, toName: 'Lumen', subject: `[TEST] ${mail.subject}`, html: mail.html });
    out.push({ email: label, sent: res.sent, files: res.files || [], pdfError: res.pdfError || null, error: res.error || null });
  }
  return out;
}
