import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requirePerm } from './_lib/auth.js';
import { sendEmail, emailStatus } from './_lib/email.js';
import { cleanName, cleanText } from './_lib/util.js';
import { runPush } from './_lib/push.js';

// What a student writes to Lumi, the character in the corner of their
// portal, sent on as an email.
//
// It was a database row first, and that is still written when the table
// is there — a row is durable, searchable, and shows on the teacher's
// dashboard. But a row nobody has told about is a row nobody reads, so
// the email is what makes this arrive: it lands in an inbox somebody
// already watches, and replying to it replies to the student.
//
// Neither half is allowed to sink the other. If the table is missing the
// email still goes; if the mail provider is down the row is still there.
// The request only fails when BOTH fail, because that is the only case
// where what the student typed has gone nowhere.

const FALLBACK_INBOX = 'lumenacademy21@gmail.com';

const KIND_LABEL = {
  technical: 'Something is broken',
  course:    'A question about their course',
  other:     'Something else',
};

export default handler(async (req, res) => {
  const { profile } = await authenticate(req);

  const body = req.body || {};
  // Phone pop-ups ride on this function: the plan allows twelve, and
  // "tell someone something" is close enough to what this one does.
  if (body.flow === 'push') return runPush(req, res, profile);
  // The group report, now, to the teacher — from the Groups list.
  if (body.flow === 'group-report-send') {
    if (!['teacher', 'assistant'].includes(profile.role)) throw new HttpError(403, 'You do not have access to do that.');
    requirePerm(profile, 'students');
    const { sendGroupReportNow } = await import('./_lib/group-report.js');
    const out = await sendGroupReportNow(String(body.group_id || ''), profile.teacher_id);
    if (out.error) throw new HttpError(400, out.error);
    return res.status(200).json(out);
  }
  // The hardest-questions email, now, to the teacher (yesterday's tests).
  if (body.flow === 'hard-questions-send') {
    if (!['teacher', 'assistant'].includes(profile.role)) throw new HttpError(403, 'You do not have access to do that.');
    requirePerm(profile, 'students');
    const { runHardQuestions } = await import('./_lib/hard-questions.js');
    return res.status(200).json(await runHardQuestions(new Date(), { onlyTeacher: profile.teacher_id, force: true }));
  }
  // A trial of the hardest-questions email, to Lumen's inbox only.
  if (body.flow === 'hard-questions-test') {
    if (!['teacher', 'owner'].includes(profile.role)) throw new HttpError(403, 'Only the teacher can do that.');
    const { runHardQuestions } = await import('./_lib/hard-questions.js');
    const inbox = (process.env.SUPPORT_EMAIL || '').trim() || FALLBACK_INBOX;
    return res.status(200).json(await runHardQuestions(new Date(), { onlyTeacher: profile.teacher_id, to: inbox }));
  }
  // A trial of the morning group report, sent to Lumen's inbox only.
  if (body.flow === 'group-report-test') {
    if (!['teacher', 'owner'].includes(profile.role)) throw new HttpError(403, 'Only the teacher can do that.');
    const { runGroupReportTest } = await import('./_lib/group-report.js');
    const inbox = (process.env.SUPPORT_EMAIL || '').trim() || FALLBACK_INBOX;
    return res.status(200).json(await runGroupReportTest(profile.teacher_id, inbox));
  }
  const name = cleanName(body.name, 'Your name');
  const message = cleanText(body.message, { max: 4000 });
  const kind = KIND_LABEL[body.kind] ? body.kind : 'other';

  if (!message || message.length < 5) {
    throw new HttpError(400, 'Tell us a little about what went wrong.');
  }

  // The student's own address, not one they typed: this is what the
  // reply goes to, so it has to be the account's.
  const from = profile.email || null;
  const inbox = (process.env.SUPPORT_EMAIL || '').trim() || FALLBACK_INBOX;

  const mail = await sendEmail({
    to: inbox,
    subject: `Lumen help — ${KIND_LABEL[kind]} — ${name}`,
    html: supportEmail({ name, from, kind: KIND_LABEL[kind], message, role: profile.role }),
    // Hitting reply in the inbox writes back to the student who asked.
    replyTo: from || undefined,
  });

  // Best effort. A space that has not run migration v4 has no such
  // table, and that must not stop the email — it is the reason this
  // endpoint exists.
  let filed = false;
  try {
    const { error } = await admin.from('support_requests').insert({
      teacher_id: profile.teacher_id,
      student_id: profile.id,
      name,
      email: from,
      kind,
      message,
    });
    filed = !error;
    if (error) console.warn('support_requests insert skipped:', error.message);
  } catch (err) {
    console.warn('support_requests insert skipped:', err?.message || err);
  }

  if (!mail.sent && !filed) {
    console.error('Support request went nowhere:', mail.error, '| email ready:', emailStatus().ready);
    throw new HttpError(502, 'We could not send that just now. Please tell your teacher directly.');
  }

  return res.status(200).json({ sent: mail.sent, filed });
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function supportEmail({ name, from, kind, message, role }) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FDF6F7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6F7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #EDDDE6;border-radius:18px;padding:34px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <tr><td>
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#A2509F">Lumen · help request</div>
          <h1 style="margin:10px 0 4px;font-size:21px;color:#1B1519">${esc(kind)}</h1>
          <p style="margin:0 0 20px;color:#8B8089;font-size:14px">
            From ${esc(name)}${from ? ` &lt;${esc(from)}&gt;` : ''}${role ? ` · ${esc(role)}` : ''}
          </p>
          <div style="background:#FAF8FA;border:1px solid #EDDDE6;border-radius:12px;padding:16px;color:#1B1519;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(message)}</div>
          <p style="margin:20px 0 0;color:#8B8089;font-size:13px">Reply to this email to answer them directly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
