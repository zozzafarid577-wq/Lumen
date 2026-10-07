import webpush from 'web-push';
import { admin } from './supabase.js';
import { HttpError } from './auth.js';

// Phone pop-ups.
//
// A device that says yes to notifications gives the browser's push
// endpoint to push_subscriptions (the page writes that row itself, under
// RLS). Sending is done here, with the service-role key, because the
// signing key must never reach a browser and because "every student on
// this course" is a list no student may read.
//
// Nothing in here is allowed to fail the thing that caused it. A message
// is sent whether or not anybody's phone buzzes; a test is saved whether
// or not the push service answers. Every sender swallows its own errors.

let vapid = null;

// The signing key is made the first time it is needed and kept in
// app_secrets, so there is no extra variable to set on the deployment.
async function keys() {
  if (vapid) return vapid;
  const read = async () => {
    const { data } = await admin.from('app_secrets').select('value').eq('name', 'vapid').maybeSingle();
    return data?.value ? JSON.parse(data.value) : null;
  };
  let k = await read();
  if (!k) {
    const fresh = webpush.generateVAPIDKeys();
    // Two first-ever calls at once: one insert wins, both read the winner.
    await admin.from('app_secrets').upsert({ name: 'vapid', value: JSON.stringify(fresh) },
      { onConflict: 'name', ignoreDuplicates: true });
    k = await read();
  }
  if (!k) throw new HttpError(503, 'Notifications are not set up yet.');
  const site = (process.env.PUBLIC_URL || 'https://lumenlearn.site').trim();
  webpush.setVapidDetails(site.startsWith('http') ? site : 'https://' + site, k.publicKey, k.privateKey);
  vapid = k;
  return k;
}

export async function publicKey() {
  return (await keys()).publicKey;
}

// Send one notification to everybody in `userIds`. Endpoints the push
// service says are gone (the app was uninstalled, permission withdrawn)
// are deleted so they are not tried again.
export async function pushTo(userIds, payload) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  try {
    await keys();
    const { data: subs } = await admin.from('push_subscriptions')
      .select('id, endpoint, p256dh, auth').in('user_id', ids);
    if (!subs?.length) return 0;
    const body = JSON.stringify(payload);
    let sent = 0;
    await Promise.all(subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body, { TTL: 60 * 60 * 24 });
        sent++;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await admin.from('push_subscriptions').delete().eq('id', s.id);
        }
      }
    }));
    return sent;
  } catch (err) {
    console.error('push failed:', err?.message || err);
    return 0;
  }
}

// ── Who to tell ───────────────────────────────────────────────────

async function courseStudents(courseId, groupId) {
  let q = admin.from('enrollments').select('student_id').eq('course_id', courseId);
  if (groupId) q = q.eq('group_id', groupId);
  const { data } = await q;
  return (data || []).map(r => r.student_id);
}

async function tenantStudents(teacherId) {
  const { data } = await admin.from('profiles').select('id')
    .eq('teacher_id', teacherId).eq('role', 'student').eq('is_active', true);
  return (data || []).map(r => r.id);
}

async function tenantStaff(teacherId) {
  const { data } = await admin.from('profiles').select('id')
    .eq('teacher_id', teacherId).in('role', ['teacher', 'assistant']).eq('is_active', true);
  return (data || []).map(r => r.id);
}

const clip = (s, n = 140) => (s || '').length > n ? s.slice(0, n - 1) + '…' : (s || '');

// ── Events ────────────────────────────────────────────────────────

export async function notifyNewTest(test) {
  if (!test?.is_active) return 0;
  if (test.open_at && new Date(test.open_at) > new Date()) return 0;   // the reminder run picks it up
  return pushTo(await courseStudents(test.course_id), {
    title: 'New test: ' + clip(test.title, 80),
    body: 'Your teacher has set a new test. Tap to open it.',
    url: '/portal/take-test.html?id=' + test.id,
    tag: 'test-' + test.id,
  });
}

// POST /api/support { flow: 'push', ... } — everything a page asks for.
//   action 'key'           → the public key a device subscribes with
//   action 'message'       → tell the other side of a conversation
//   action 'announcement'  → tell the students an announcement reaches
//   action 'unit'          → tell a course a unit has opened
export async function runPush(req, res, profile) {
  const body = req.body || {};
  const action = body.action;

  if (action === 'key') return res.status(200).json({ key: await publicKey() });

  if (action === 'message') {
    const { data: m } = await admin.from('messages')
      .select('id, teacher_id, student_id, sender_id, from_staff, body').eq('id', body.message_id).single();
    if (!m || m.sender_id !== profile.id) throw new HttpError(404, 'That message was not found.');
    const to = m.from_staff ? [m.student_id] : await tenantStaff(m.teacher_id);
    const sent = await pushTo(to.filter(id => id !== profile.id), {
      title: m.from_staff ? 'New message from your teacher' : 'Message from ' + clip(profile.full_name, 60),
      body: clip(m.body),
      url: m.from_staff ? '/portal/messages.html' : '/teacher/messages.html?student=' + m.student_id,
      tag: 'msg-' + m.student_id,
    });
    return res.status(200).json({ sent });
  }

  // Everything below is staff telling students something.
  if (!['teacher', 'assistant'].includes(profile.role)) throw new HttpError(403, 'You do not have access to do that.');

  if (action === 'announcement') {
    const { data: a } = await admin.from('announcements')
      .select('id, teacher_id, title, body, course_id, is_active').eq('id', body.announcement_id).single();
    if (!a || a.teacher_id !== profile.teacher_id) throw new HttpError(404, 'That announcement was not found.');
    if (!a.is_active) return res.status(200).json({ sent: 0 });
    const to = a.course_id ? await courseStudents(a.course_id) : await tenantStudents(a.teacher_id);
    const sent = await pushTo(to, {
      title: clip(a.title, 80), body: clip(a.body), url: '/portal/announcements.html', tag: 'ann-' + a.id,
    });
    return res.status(200).json({ sent });
  }

  if (action === 'unit') {
    const { data: u } = await admin.from('modules')
      .select('id, teacher_id, course_id, title, is_done').eq('id', body.module_id).single();
    if (!u || u.teacher_id !== profile.teacher_id) throw new HttpError(404, 'That unit was not found.');
    if (!u.is_done) return res.status(200).json({ sent: 0 });
    const sent = await pushTo(await courseStudents(u.course_id), {
      title: 'New lessons: ' + clip(u.title, 80),
      body: 'A new unit is open on your course.',
      url: '/portal/courses.html', tag: 'unit-' + u.id,
    });
    return res.status(200).json({ sent });
  }

  throw new HttpError(400, 'Unknown notification.');
}

// ── The daily reminder ────────────────────────────────────────────
// Run once a day by the Vercel cron (GET /api/health?task=reminders).
// "Due in the next day" for tests set with a deadline, homework, and
// tests that close soon — only to students who have not done them yet,
// and never the same reminder twice (notify_log).
export async function runReminders() {
  const now = new Date();
  const soon = new Date(now.getTime() + 26 * 3600 * 1000).toISOString();
  const iso = now.toISOString();
  let sent = 0;

  const once = async (key) => {
    const { error } = await admin.from('notify_log').insert({ key });
    return !error;          // a duplicate key means it was sent already
  };

  const remind = async (kind, id, students, payload) => {
    for (const sid of students) {
      if (await once(`due:${kind}:${id}:${sid}`)) sent += await pushTo([sid], payload);
    }
  };

  const attempted = async (testId) => {
    const { data } = await admin.from('test_attempts').select('student_id').eq('test_id', testId);
    return new Set((data || []).map(r => r.student_id));
  };

  // Tests set with a due date.
  const { data: ta } = await admin.from('test_assignments')
    .select('id, test_id, course_id, group_id, due_at, practice_tests(title, is_active)')
    .gte('due_at', iso).lte('due_at', soon);
  for (const a of ta || []) {
    if (!a.practice_tests?.is_active) continue;
    const done = await attempted(a.test_id);
    const todo = (await courseStudents(a.course_id, a.group_id)).filter(s => !done.has(s));
    await remind('ta', a.id, todo, {
      title: 'Due soon: ' + clip(a.practice_tests.title, 80),
      body: 'This test is due ' + whenText(a.due_at) + '.',
      url: '/portal/take-test.html?id=' + a.test_id, tag: 'due-' + a.test_id,
    });
  }

  // Tests that close soon.
  const { data: tc } = await admin.from('practice_tests')
    .select('id, course_id, title, close_at').eq('is_active', true).gte('close_at', iso).lte('close_at', soon);
  for (const t of tc || []) {
    const done = await attempted(t.id);
    const todo = (await courseStudents(t.course_id)).filter(s => !done.has(s));
    await remind('tc', t.id, todo, {
      title: 'Closing soon: ' + clip(t.title, 80),
      body: 'This test closes ' + whenText(t.close_at) + '.',
      url: '/portal/take-test.html?id=' + t.id, tag: 'due-' + t.id,
    });
  }

  // Homework.
  const { data: hw } = await admin.from('assignments')
    .select('id, course_id, title, due_at').eq('is_active', true).gte('due_at', iso).lte('due_at', soon);
  for (const h of hw || []) {
    const { data: subs } = await admin.from('assignment_submissions').select('student_id').eq('assignment_id', h.id);
    const done = new Set((subs || []).map(r => r.student_id));
    const todo = (await courseStudents(h.course_id)).filter(s => !done.has(s));
    await remind('hw', h.id, todo, {
      title: 'Homework due: ' + clip(h.title, 80),
      body: 'Due ' + whenText(h.due_at) + '.',
      url: '/portal/assignments.html', tag: 'hw-' + h.id,
    });
  }

  // Tests whose opening time has come since yesterday's run.
  const yesterday = new Date(now.getTime() - 26 * 3600 * 1000).toISOString();
  const { data: opened } = await admin.from('practice_tests')
    .select('id, course_id, title, open_at').eq('is_active', true).gte('open_at', yesterday).lte('open_at', iso);
  for (const t of opened || []) {
    if (await once(`open:${t.id}`)) {
      sent += await pushTo(await courseStudents(t.course_id), {
        title: 'New test: ' + clip(t.title, 80), body: 'A new test is open. Tap to start it.',
        url: '/portal/take-test.html?id=' + t.id, tag: 'test-' + t.id,
      });
    }
  }

  return sent;
}

// Egypt time, because that is where every student is.
function whenText(at) {
  return new Date(at).toLocaleString('en-GB', {
    weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo',
  });
}
