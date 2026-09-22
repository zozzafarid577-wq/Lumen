import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emailStatus, sendEmail, studentWelcome, passwordReset, teacherWelcome, loginUrlFor } from '../../api/_lib/email.js';

const ORIGINAL = { ...process.env };

function configure({ key = 'xkeysib-test', sender = 'hello@example.com', url } = {}) {
  if (key) process.env.BREVO_API_KEY = key; else delete process.env.BREVO_API_KEY;
  if (sender) process.env.BREVO_SENDER_EMAIL = sender; else delete process.env.BREVO_SENDER_EMAIL;
  if (url) process.env.PUBLIC_URL = url; else delete process.env.PUBLIC_URL;
}

beforeEach(() => configure());
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

describe('configuration', () => {
  it('is not ready without an API key', () => {
    configure({ key: null });
    expect(emailStatus()).toMatchObject({ ready: false });
    expect(emailStatus().why).toMatch(/BREVO_API_KEY/);
  });

  it('is not ready without a verified sender', () => {
    // Brevo refuses anything from an unverified address, so a missing
    // sender is worth naming rather than failing per-send.
    configure({ sender: null });
    expect(emailStatus().why).toMatch(/BREVO_SENDER_EMAIL/);
  });

  it('is ready with both', () => {
    expect(emailStatus()).toEqual({ ready: true });
  });
});

describe('sendEmail', () => {
  it('posts the message to Brevo', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messageId: '1' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await sendEmail({ to: 'a@b.com', toName: 'A', subject: 'Hi', html: '<p>Hi</p>' });

    expect(out).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('xkeysib-test');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual([{ email: 'a@b.com', name: 'A' }]);
    expect(body.sender.email).toBe('hello@example.com');
  });

  it('reports a refusal instead of throwing', async () => {
    // An email is the last step of creating an account. It must never be
    // able to undo a student who now exists.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({ message: 'sender not verified' }) }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendEmail({ to: 'a@b.com', subject: 'Hi', html: 'x' }))
      .resolves.toEqual({ sent: false, error: 'sender not verified' });

    quiet.mockRestore();
  });

  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('socket hang up'); });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: 'x' });
    expect(out.sent).toBe(false);
    expect(out.error).toMatch(/socket hang up/);

    quiet.mockRestore();
  });

  it('does not call Brevo when it is not configured', async () => {
    configure({ key: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await sendEmail({ to: 'a@b.com', subject: 'Hi', html: 'x' });
    expect(out.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('templates', () => {
  const args = { name: 'Sara Ahmed', email: 'sara@example.com', password: 'Abc!2345', spaceName: 'Advanced Biology', loginUrl: 'https://lumen.test/login.html' };

  it('carry the credentials and the sign-in link', () => {
    for (const build of [studentWelcome, passwordReset, teacherWelcome]) {
      const { subject, html } = build(args);
      expect(subject.length).toBeGreaterThan(5);
      expect(html).toContain('sara@example.com');
      expect(html).toContain('Abc!2345');
      expect(html).toContain('https://lumen.test/login.html');
    }
  });

  it('escape what goes into them', () => {
    const { html } = studentWelcome({ ...args, spaceName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('name the teacher’s space, not the product', () => {
    expect(studentWelcome(args).subject).toContain('Advanced Biology');
    // With no space name it still has to read as a sentence.
    expect(studentWelcome({ ...args, spaceName: null }).subject).toContain('Lumen');
  });
});

describe('loginUrlFor', () => {
  it('prefers PUBLIC_URL', () => {
    configure({ url: 'https://lumen.education/' });
    expect(loginUrlFor({ headers: { host: 'whatever' } })).toBe('https://lumen.education/login.html');
  });

  it('falls back to the host the request came in on', () => {
    expect(loginUrlFor({ headers: { host: 'lumen.vercel.app' } })).toBe('https://lumen.vercel.app/login.html');
  });

  it('uses http for local development', () => {
    expect(loginUrlFor({ headers: { host: 'localhost:3000' } })).toBe('http://localhost:3000/login.html');
  });
});
