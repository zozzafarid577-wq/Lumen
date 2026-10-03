import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles } from './_lib/auth.js';
import { sendEmail } from './_lib/email.js';

// Telling a parent how their child did, on the day.
//
// The attempt itself is written by the browser under row-level security,
// so this is asked for by the browser too — but nothing here is taken on
// the browser's word. The caller names a test; the server finds THEIR
// newest finished attempt at it, reads the mark out of the database, and
// sends that. A student cannot email their parent a score they did not
// get, or a score belonging to somebody else.
//
// parent_emailed_at is what stops it going twice. A refreshed results
// page, or the retry that follows a dropped connection, asks again — and
// gets a quiet "already sent".

export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['student']);

  const testId = String(req.body?.test_id || '');
  if (!testId) throw new HttpError(400, 'Which test?');

  // Their own attempt, chosen by the server. `student_id` comes from the
  // session, never from the request.
  const { data: attempt, error } = await admin.from('test_attempts')
    .select('id, test_id, percentage, score, max_score, passed, completed_at')
    .eq('student_id', profile.id)
    .eq('test_id', testId)
    .not('completed_at', 'is', null)
    .is('parent_emailed_at', null)
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // No such column means migration v9 has not been run. That is a
  // missing feature, not a failed test — the mark itself is safe.
  if (error) {
    console.warn('result-email lookup failed:', error.message);
    return res.status(200).json({ sent: false, why: 'unavailable' });
  }
  if (!attempt) return res.status(200).json({ sent: false, why: 'already-sent-or-none' });

  const [{ data: student }, { data: test }, { data: teacher }] = await Promise.all([
    admin.from('profiles').select('full_name, parent_email').eq('id', profile.id).single(),
    admin.from('practice_tests').select('title, passing_score_pct').eq('id', testId).single(),
    admin.from('teachers').select('display_name').eq('id', profile.teacher_id).maybeSingle(),
  ]);

  const to = (student?.parent_email || '').trim();
  if (!to) return res.status(200).json({ sent: false, why: 'no-parent-email' });

  // The mark as marks — 18/20 — which is how Lumen shows every score.
  const shown = attempt.score != null && attempt.max_score != null
    ? `${attempt.score}/${attempt.max_score}`
    : `${Math.round(parseFloat(attempt.percentage) || 0)}%`;
  const mail = await sendEmail({
    to,
    subject: `${student.full_name} — ${test?.title || 'test'} — ${shown}`,
    html: resultEmail({
      student: student.full_name,
      test: test?.title || 'a test',
      shown,
      score: attempt.score,
      maxScore: attempt.max_score,
      passed: attempt.passed,
      passMark: test?.passing_score_pct,
      space: teacher?.display_name || 'Lumen',
      when: attempt.completed_at,
    }),
  });

  // Stamped only on a send that worked, so a provider having a bad
  // afternoon does not cost the parent the result altogether — the next
  // attempt at this test will carry it.
  if (mail.sent) {
    await admin.from('test_attempts')
      .update({ parent_emailed_at: new Date().toISOString() }).eq('id', attempt.id);
  } else {
    console.warn('result email not sent:', mail.error);
  }

  return res.status(200).json({ sent: mail.sent });
});

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function resultEmail({ student, test, shown, score, maxScore, passed, passMark, space, when }) {
  const colour = passed ? '#147A57' : '#C62F45';
  const date = when ? new Date(when).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FDF6F7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6F7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #EDDDE6;border-radius:18px;padding:34px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <tr><td>
          <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#A2509F">${esc(space)}</div>
          <h1 style="margin:10px 0 6px;font-size:21px;color:#1B1519">${esc(student)}'s result</h1>
          <p style="margin:0 0 22px;color:#8B8089;font-size:14px">${esc(test)}${date ? ` · ${esc(date)}` : ''}</p>

          <div style="text-align:center;background:#FAF8FA;border:1px solid #EDDDE6;border-radius:14px;padding:22px">
            <div style="font-size:42px;font-weight:800;line-height:1;color:${colour}">${esc(shown)}</div>
            <div style="margin-top:8px;font-size:14px;color:#554C53">
              ${passed ? 'Passed' : 'Did not pass'}${passMark != null ? ` (pass mark ${esc(passMark)}%)` : ''}
            </div>
          </div>

          <p style="margin:22px 0 0;color:#554C53;font-size:14px;line-height:1.6">
            This is an automatic message sent when a test is finished. Please reply to your
            teacher directly if you would like to talk about it.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
