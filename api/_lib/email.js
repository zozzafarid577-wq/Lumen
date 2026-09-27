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
      const raw = body?.message || `Brevo returned ${resp.status}`;
      console.error('Brevo send failed:', raw);
      return { sent: false, error: explain(raw) };
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

// Brevo's refusals are written for whoever set the account up, not for
// a teacher in the middle of a lesson. The two that actually happen get
// turned into something with an action in it; anything else goes
// through as it came, because a message nobody predicted is more use
// verbatim than summarised into "something went wrong".
//
// "blocked: due to blacklist user" is the common one, and it is worth
// knowing what it means: Brevo keeps a blocklist per account, and an
// address lands on it when a message to it hard-bounces (the address
// does not exist), when somebody marks a message as spam, or when they
// unsubscribe. Transactional mail is refused for a blocklisted address
// too — so an address that was mistyped once keeps failing long after
// it is corrected, until it is taken off the list in
// Brevo → Contacts → Blocklisted.
export function explain(raw) {
  const text = String(raw || '');

  if (/blacklist|blocked/i.test(text)) {
    return 'That address is on the mail provider’s blocklist, so nothing can be emailed to it. '
      + 'It gets there by bouncing, by somebody marking an earlier email as spam, or by unsubscribing. '
      + 'Send them the link yourself, and remove the address in Brevo → Contacts → Blocklisted if it is a real one.';
  }

  if (/invalid|not valid|malformed/i.test(text) && /email|recipient|to/i.test(text)) {
    return 'The mail provider will not accept that address — check it for a typo. Send them the link yourself in the meantime.';
  }

  return text;
}

// ── Templates ─────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One layout behind every message, so a Lumen email is recognisable
// before a word of it is read.
//
// Written the way email has to be written rather than the way the site
// is: tables for structure, styles inline, no web fonts and no images to
// be blocked. The brand band uses background-color first and a gradient
// second, so a client that ignores the gradient still gets purple rather
// than a white gap where the header should be.
//
// `rows` are the details being handed over; `highlight` names the one of
// them that is the point of the message — a password — and gets it out
// of the small print and into a panel of its own. `bullets` are the
// short, cheerful "here is what is waiting" lines; they are optional and
// left out of anything serious.
const BRAND = '#A2509F';
const INK = '#1B1519';
const INK_2 = '#554C53';
const MUTED = '#8B8089';
const LINE = '#EDDDE6';
const FONT = '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

function layout({ heading, intro, rows = [], highlight, bullets = [], note, loginUrl, cta = 'Sign in to Lumen', arabic = null }) {
  // The same message again, in Arabic, under a rule. Two rules it has to
  // follow to arrive readable: dir="rtl" on the block, because Arabic
  // punctuation lands on the wrong side of a sentence without it, and
  // text-align:right, because several clients ignore dir on a <td> and
  // honour the alignment.
  //
  // The credentials are not repeated — an address and a password read
  // the same in both languages, and a second copy of them is one more
  // thing to mistype. Their labels carry both languages instead.
  const rtl = arabic ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="margin:24px 0 0;padding-top:22px;border-top:1px solid ${LINE}">
            <tr><td style="text-align:right;direction:rtl">
              <h2 style="margin:0 0 10px;font-size:19px;line-height:1.4;color:${INK}">${arabic.heading}</h2>
              <p style="margin:0 0 14px;font-size:15px;line-height:1.8;color:${INK_2}">${arabic.intro}</p>
              ${arabic.note ? `<p style="margin:0;font-size:13px;line-height:1.8;color:${MUTED}">${arabic.note}</p>` : ''}
            </td></tr>
          </table>` : '';

  // The first row needs no rule above it; the rest are separated by one.
  const line = ([label, value], i) => {
    const rule = i ? `border-top:1px solid ${LINE};` : '';
    return `
    <tr>
      <td style="${rule}padding:11px 0;color:${MUTED};font-size:13px">${esc(label)}</td>
      <td style="${rule}padding:11px 0;text-align:right;font-weight:700;color:${INK};font-size:14px;font-family:ui-monospace,Menlo,monospace">${esc(value)}</td>
    </tr>`;
  };

  const detail = rows.length ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8FA;border:1px solid ${LINE};border-radius:14px;padding:4px 18px;margin:0 0 22px">
            ${rows.map(line).join('')}
          </table>` : '';

  const chip = highlight ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
            <tr><td align="center" style="background:#FBF0FA;border:1px dashed ${BRAND};border-radius:14px;padding:18px 20px">
              <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:${BRAND};margin-bottom:8px">${esc(highlight[0])}</div>
              <div style="font-size:23px;font-weight:700;color:${INK};font-family:ui-monospace,Menlo,monospace;letter-spacing:1px;word-break:break-all">${esc(highlight[1])}</div>
            </td></tr>
          </table>` : '';

  const list = bullets.length ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
            ${bullets.map(b => `
            <tr>
              <td width="22" valign="top" style="padding:5px 0;color:${BRAND};font-size:15px;font-weight:700">&bull;</td>
              <td style="padding:5px 0;font-size:14px;line-height:1.55;color:${INK_2}">${b}</td>
            </tr>`).join('')}
          </table>` : '';

  // The charset is not decoration: a teacher's space is called things
  // like "Dr. Hany — Biology", and without it that dash arrives as
  // mojibake in half the mail clients there are.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#FDF6F7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6F7;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};border-radius:20px;overflow:hidden;font-family:${FONT}">

        <tr><td bgcolor="${BRAND}" style="background-color:${BRAND};background-image:linear-gradient(120deg,#7E3C7C 0%,${BRAND} 55%,#C070BD 100%);padding:26px 34px">
          <div style="font-size:26px;font-weight:500;letter-spacing:-1px;color:#ffffff">L<span style="font-weight:700;border-bottom:3px solid #EBB8E9">u</span>men</div>
          <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#F0D3EF;margin-top:6px">Educate with Excellence</div>
        </td></tr>

        <tr><td style="padding:32px 34px 34px">
          <h1 style="margin:0 0 12px;font-size:21px;line-height:1.3;color:${INK}">${esc(heading)}</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:${INK_2}">${intro}</p>
${detail}${chip}${list}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
            <tr><td align="center">
              <a href="${esc(loginUrl)}" style="display:inline-block;background-color:${BRAND};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:15px 34px;border-radius:9999px">${esc(cta)} &rarr;</a>
            </td></tr>
          </table>

          <p style="margin:0;padding-top:18px;border-top:1px solid ${LINE};font-size:13px;line-height:1.6;color:${MUTED}">${note}</p>
${rtl}
        </td></tr>
      </table>
      <p style="max-width:520px;margin:18px auto 0;font-size:12px;color:${MUTED};font-family:${FONT};text-align:center">
        Sent by Lumen. If the button does not work, open <span style="color:${INK_2}">${esc(loginUrl)}</span>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

const firstName = (name) => (name ? esc(String(name).trim().split(/\s+/)[0]) : '');

// The one email a new student gets, and the one a student gets when a
// teacher lets them back in. It carries a link, never a password —
// there is no password to carry, which is the point: the only one the
// account ever has is the one they are about to choose.
//
// `kind` picks the wording. Everything else about the message is the
// same, because it is the same link doing the same thing.
export function studentInvite({ name, email, spaceName, setupUrl, days = 14, kind = 'welcome' }) {
  const welcome = kind === 'welcome';
  const where = spaceName ? ` on <strong>${esc(spaceName)}</strong>` : '';

  return {
    subject: welcome
      ? `Set up your ${spaceName || 'Lumen'} account 🎉`
      : `Choose a new password for ${spaceName || 'Lumen'}`,
    html: layout({
      heading: welcome
        ? `Welcome${name ? ', ' + firstName(name) : ''}!`
        : `${name ? firstName(name) + ', let' : 'Let'}'s get you back in`,
      intro: welcome
        ? `Your teacher has made you an account${where}. Press the button below and choose a password — you pick it yourself, and nobody else ever sees it.`
        : `Your teacher has sent you a new sign-in link${where}. Press the button below to choose a new password. Your old one no longer works.`,
      rows: [['Your email', email]],
      bullets: welcome ? [
        '<strong>Recordings and materials</strong> for every lesson, kept for the whole term',
        '<strong>Tests</strong> that give you your score the moment you finish',
        '<strong>Homework</strong> to hand in, and the feedback that comes back',
        '<strong>Your progress</strong>, so you always know where you stand',
      ] : [],
      note: `This link works once, and for ${days} days. After that, or if you have already used it, ask your teacher to send you another.`,
      loginUrl: setupUrl,
      cta: welcome ? 'Choose my password' : 'Choose a new password',
      arabic: {
        heading: welcome
          ? '\u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a Lumen'
          : '\u0627\u062e\u062a\u0631 \u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u062c\u062f\u064a\u062f\u0629',
        intro: welcome
          ? '\u0623\u0646\u0634\u0623 \u0644\u0643 \u0645\u062f\u0631\u0651\u0633\u0643 \u062d\u0633\u0627\u0628\u064b\u0627. \u0627\u0636\u063a\u0637 \u0639\u0644\u0649 \u0627\u0644\u0632\u0631 \u0628\u0627\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u062e\u062a\u0631 \u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u062e\u0627\u0635\u0629 \u0628\u0643 \u2014 \u0623\u0646\u062a \u0648\u062d\u062f\u0643 \u0645\u0646 \u064a\u0639\u0631\u0641\u0647\u0627\u060c \u0648\u0644\u0627 \u064a\u0631\u0627\u0647\u0627 \u0623\u062d\u062f \u063a\u064a\u0631\u0643.'
          : '\u0623\u0631\u0633\u0644 \u0644\u0643 \u0645\u062f\u0631\u0651\u0633\u0643 \u0631\u0627\u0628\u0637\u064b\u0627 \u062c\u062f\u064a\u062f\u064b\u0627. \u0627\u0636\u063a\u0637 \u0639\u0644\u0649 \u0627\u0644\u0632\u0631 \u0628\u0627\u0644\u0623\u0639\u0644\u0649 \u0648\u0627\u062e\u062a\u0631 \u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u062c\u062f\u064a\u062f\u0629. \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u0642\u062f\u064a\u0645\u0629 \u0644\u0645 \u062a\u0639\u062f \u062a\u0639\u0645\u0644.',
        note: `\u064a\u0639\u0645\u0644 \u0647\u0630\u0627 \u0627\u0644\u0631\u0627\u0628\u0637 \u0645\u0631\u0629 \u0648\u0627\u062d\u062f\u0629 \u0641\u0642\u0637\u060c \u0648\u0644\u0645\u062f\u0629 ${days} \u064a\u0648\u0645\u064b\u0627. `
          + '\u0628\u0639\u062f \u0630\u0644\u0643 \u0627\u0637\u0644\u0628 \u0645\u0646 \u0645\u062f\u0631\u0651\u0633\u0643 \u0625\u0631\u0633\u0627\u0644 \u0631\u0627\u0628\u0637 \u062c\u062f\u064a\u062f.',
      },
    }),
  };
}

// Sent the moment a student has a working account and a password they
// chose — from registering through a batch link, or from opening a
// set-up link. One template for both, because from the student's side
// it is the same event: they are in, and these are the two things they
// have to keep.
//
// It carries the password back. That is a deliberate trade, not an
// oversight: the address it goes to is the one that can already reset
// this account through "forgotten password", so it widens nothing —
// and a student who cannot find their password is a message to their
// teacher and a lesson spent on it. What it costs is a plaintext
// password sitting in an inbox, which is why it also says not to pass
// it on. Drop `highlight` here and the email keeps working without it.
//
// In both languages, because half these students read the Arabic and
// skip the English, and the ones who need this most are the ones least
// likely to puzzle it out.
export function accountReady({ name, email, password, spaceName, loginUrl }) {
  const where = spaceName ? ` on <strong>${esc(spaceName)}</strong>` : '';

  return {
    subject: `Your ${spaceName || 'Lumen'} sign-in details 🎉 — بيانات الدخول`,
    html: layout({
      heading: `You're in${name ? ', ' + firstName(name) : ''}!`,
      intro: `Your account${where} is ready. These are the two things you sign in with — <strong>write them down somewhere you will find them again.</strong>`,
      rows: [['Your email · بريدك الإلكتروني', email]],
      highlight: password ? ['Your password · كلمة المرور', password] : null,
      note: 'Keep this to yourself — anybody with these can open your account. '
        + 'If you forget your password, ask your teacher to send you a new link: nobody can look it up for you.',
      loginUrl,
      cta: 'Sign in',
      arabic: {
        heading: 'تم تفعيل حسابك!',
        intro: 'حسابك جاهز الآن. البيانات الموجودة بالأعلى هي ما ستستخدمه لتسجيل الدخول في كل مرة — '
          + '<strong>احتفظ بها في مكان آمن ولا تنساها.</strong>',
        note: 'لا تشارك هذه البيانات مع أحد. '
          + 'إذا نسيت كلمة المرور، اطلب من مدرّسك إرسال رابط جديد، '
          + 'فلا يستطيع أحد استرجاعها نيابة عنك.',
      },
    }),
  };
}

export function teacherWelcome({ name, email, password, spaceName, loginUrl }) {
  return {
    subject: 'Your Lumen space is ready',
    html: layout({
      heading: `Welcome to Lumen${name ? ', ' + firstName(name) : ''}!`,
      intro: `Your space${spaceName ? `, <strong>${esc(spaceName)}</strong>,` : ''} is set up and waiting for you. Sign in to add your courses and your first students.`,
      rows: [['Your email', email]],
      highlight: ['Your password', password],
      note: 'You will be asked to choose your own password the first time you sign in.',
      loginUrl,
      cta: 'Open my dashboard',
    }),
  };
}

// Sent when Lumen changes the address a teacher signs in with. It goes
// to the new address, which is the one they now have to use — and which
// arriving at all proves the new address was typed correctly.
export function signInEmailChanged({ name, oldEmail, newEmail, spaceName, loginUrl }) {
  return {
    subject: 'Your Lumen sign-in email has changed',
    html: layout({
      heading: 'A new sign-in email',
      intro: `Lumen has changed the email address on your${spaceName ? ` <strong>${esc(spaceName)}</strong>` : ''} account${name ? `, ${esc(name.split(' ')[0])}` : ''}. Sign in with the new one from now on — your password has not changed.`,
      rows: [['Was', oldEmail], ['Now', newEmail]],
      note: 'If you did not ask for this, contact Lumen straight away.',
      loginUrl,
    }),
  };
}

// Where the sign-in page lives.
//
// PUBLIC_URL pins it. Leaving it unset is a valid choice, not an
// oversight: the link then follows the host the request arrived on, so
// it is already right the day the site moves to a different domain,
// whereas a PUBLIC_URL nobody remembered to update sends every teacher
// to a domain that no longer answers.
//
// The trade is preview deployments — mail triggered from one carries
// that deployment's throwaway URL. Pin it once the final domain exists.
export function loginUrlFor(req) {
  return siteUrlFor(req, '/login.html');
}

// An absolute link back to this deployment. Everything sent outwards
// needs one: an email is read somewhere the site's own relative paths
// mean nothing, and an invite link is pasted into WhatsApp.
export function siteUrlFor(req, path = '/') {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) {
    // Tolerate "lumen.education" as well as "https://lumen.education".
    // This gets edited by hand when a domain changes, and a missing
    // scheme would otherwise produce a link that goes nowhere.
    const base = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
    return `${base}${path}`;
  }

  const host = (req?.headers?.host || '').trim();
  if (!host) return path;
  const proto = /^(localhost|127\.|\[::1\])/.test(host) ? 'http' : 'https';
  return `${proto}://${host}${path}`;
}
