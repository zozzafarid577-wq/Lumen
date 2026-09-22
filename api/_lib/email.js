// Sending mail through Brevo.
//
// Two rules hold everywhere in this file:
//
//   1. Nothing here ever throws. An email is the last step of creating
//      an account, and a mail provider having a bad afternoon must not
//      undo a student who now exists. Every send returns {sent, error}
//      and the caller carries on either way.
//
//   2. The password is always shown on screen as well. Email is the
//      convenience, never the only copy — which is also why a failed
//      send is reported back to the teacher rather than swallowed.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 8000;

function key() { return (process.env.BREVO_API_KEY || '').trim(); }

function sender() {
  const email = (process.env.BREVO_SENDER_EMAIL || '').trim();
  const name = (process.env.BREVO_SENDER_NAME || 'Lumen').trim();
  return email ? { email, name } : null;
}

// Brevo refuses anything from an address that has not been verified in
// the dashboard, so a missing sender is a configuration problem worth
// naming rather than a silent no-op.
export function emailStatus() {
  if (!key()) return { ready: false, why: 'BREVO_API_KEY is not set' };
  if (!sender()) return { ready: false, why: 'BREVO_SENDER_EMAIL is not set' };
  return { ready: true };
}

export async function sendEmail({ to, toName, subject, html, replyTo }) {
  const status = emailStatus();
  if (!status.ready) return { sent: false, error: status.why };
  if (!to || !subject || !html) return { sent: false, error: 'Nothing to send.' };

  // A hung request must not hold a serverless function open until it is
  // killed — the account is already made by this point.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(BREVO_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'api-key': key(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: sender(),
        to: [{ email: to, name: toName || undefined }],
        replyTo: replyTo ? { email: replyTo } : undefined,
        subject,
        htmlContent: html,
      }),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const why = body?.message || `Brevo returned ${resp.status}`;
      console.error('Brevo send failed:', why);
      return { sent: false, error: why };
    }
    return { sent: true };
  } catch (err) {
    const why = err?.name === 'AbortError' ? 'The mail provider did not respond in time.' : String(err?.message || err);
    console.error('Brevo send failed:', why);
    return { sent: false, error: why };
  } finally {
    clearTimeout(timer);
  }
}

// ── Templates ─────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout({ heading, intro, rows, note, loginUrl }) {
  const line = ([label, value]) => `
    <tr>
      <td style="padding:9px 0;color:#8B8089;font-size:14px">${esc(label)}</td>
      <td style="padding:9px 0;text-align:right;font-weight:700;color:#1B1519;font-size:14px;font-family:ui-monospace,Menlo,monospace">${esc(value)}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FDF6F7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6F7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #EDDDE6;border-radius:18px;padding:34px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <tr><td>
          <div style="font-size:25px;font-weight:500;letter-spacing:-1px;color:#1B1519;margin-bottom:26px">L<span style="color:#A2509F;font-weight:700;border-bottom:3px solid #A2509F">u</span>men</div>
          <h1 style="margin:0 0 12px;font-size:20px;color:#1B1519">${esc(heading)}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#554C53">${intro}</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8FA;border:1px solid #EDDDE6;border-radius:12px;padding:6px 18px;margin-bottom:24px">
            ${rows.map(line).join('')}
          </table>

          <div style="text-align:center;margin-bottom:24px">
            <a href="${esc(loginUrl)}" style="display:inline-block;background:#A2509F;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 30px;border-radius:9999px">Sign in to Lumen</a>
          </div>

          <p style="margin:0;font-size:13px;line-height:1.6;color:#8B8089">${note}</p>
        </td></tr>
      </table>
      <p style="max-width:520px;margin:18px auto 0;font-size:12px;color:#8B8089;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;text-align:center">
        Lumen — Educate with Excellence
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function studentWelcome({ name, email, password, spaceName, loginUrl }) {
  return {
    subject: `Your ${spaceName || 'Lumen'} account is ready`,
    html: layout({
      heading: `Welcome${name ? ', ' + esc(name.split(' ')[0]) : ''}`,
      intro: `Your teacher has created your account${spaceName ? ` on <strong>${esc(spaceName)}</strong>` : ''}. Here is how to sign in.`,
      rows: [['Email', email], ['Password', password]],
      note: 'You will be asked to choose your own password the first time you sign in. Keep these details to yourself.',
      loginUrl,
    }),
  };
}

export function passwordReset({ name, email, password, spaceName, loginUrl }) {
  return {
    subject: `Your ${spaceName || 'Lumen'} password has been reset`,
    html: layout({
      heading: 'A new password',
      intro: `Your teacher has reset the password on your account${name ? ` , ${esc(name.split(' ')[0])}` : ''}. Your old one no longer works.`,
      rows: [['Email', email], ['New password', password]],
      note: 'You will be asked to choose your own password the next time you sign in. If you did not expect this, speak to your teacher.',
      loginUrl,
    }),
  };
}

export function teacherWelcome({ name, email, password, spaceName, loginUrl }) {
  return {
    subject: 'Your Lumen space is ready',
    html: layout({
      heading: `Welcome to Lumen${name ? ', ' + esc(name.split(' ')[0]) : ''}`,
      intro: `Your space${spaceName ? `, <strong>${esc(spaceName)}</strong>,` : ''} is set up and waiting for you. Sign in to add your courses and your first students.`,
      rows: [['Email', email], ['Password', password]],
      note: 'You will be asked to choose your own password the first time you sign in.',
      loginUrl,
    }),
  };
}

// Where the sign-in page lives. PUBLIC_URL wins; otherwise the host the
// request arrived on, which is right on Vercel and in local dev without
// anything being configured.
export function loginUrlFor(req) {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return `${configured}/login.html`;
  const host = req?.headers?.host;
  if (!host) return '/login.html';
  const proto = /^localhost|^127\./.test(host) ? 'http' : 'https';
  return `${proto}://${host}/login.html`;
}
