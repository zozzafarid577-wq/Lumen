import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emailStatus, sendEmail, explain, accountReady, studentInvite, teacherWelcome, signInEmailChanged, loginUrlFor } from '../../api/_lib/email.js';

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

  it('carry the address and the link, whatever they are for', () => {
    for (const build of [accountReady, teacherWelcome]) {
      const { subject, html } = build(args);
      expect(subject.length).toBeGreaterThan(5);
      expect(html).toContain('sara@example.com');
      expect(html).toContain('https://lumen.test/login.html');
    }
    // Only the teacher is still handed a password to sign in with.
    expect(teacherWelcome(args).html).toContain('Abc!2345');
  });

  it('escape what goes into them', () => {
    const { html } = accountReady({ ...args, spaceName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('name the teacher’s space, not the product', () => {
    expect(accountReady(args).subject).toContain('Advanced Biology');
    // With no space name it still has to read as a sentence.
    expect(accountReady({ ...args, spaceName: null }).subject).toContain('Lumen');
  });

  it('invite a student with a link and no password at all', () => {
    // A student is never sent a password, because one is never made for
    // them. The link is the whole message.
    const setupUrl = 'https://lumen.test/setup/AbC123';

    for (const kind of ['welcome', 'reset']) {
      const { subject, html } = studentInvite({
        name: 'Sara Ahmed', email: 'sara@example.com',
        spaceName: 'Advanced Biology', setupUrl, days: 14, kind,
      });

      expect(subject.length, kind).toBeGreaterThan(5);
      expect(html, kind).toContain('sara@example.com');
      expect(html, kind).toContain(setupUrl);
      expect(html, kind).not.toContain('Abc!2345');
      // Saying so is what stops a student sitting on it for a month.
      expect(html, kind).toMatch(/works once, and for 14 days/i);
    }

    // A reset says the old password has gone; a welcome has nothing to
    // say about one, because there never was one.
    expect(studentInvite({ ...args, setupUrl, kind: 'reset' }).html).toMatch(/no longer works/i);
  });

  it('carry the Lumen header on every message', () => {
    // A gradient no client is obliged to honour, over a background colour
    // every client does: the band must never render as a white gap.
    for (const html of [
      accountReady(args).html,
      studentInvite({ ...args, setupUrl: 'https://lumen.test/setup/AbC123' }).html,
    ]) {
      expect(html).toMatch(/bgcolor="#A2509F"/);
      expect(html).toContain('Educate with Excellence');
    }
  });

  it('show both addresses when the sign-in email changes', () => {
    const { subject, html } = signInEmailChanged({
      name: 'Sara Ahmed', oldEmail: 'sara@old.example', newEmail: 'sara@new.example',
      spaceName: 'Advanced Biology', loginUrl: 'https://lumen.test/login.html',
    });

    expect(subject).toMatch(/sign-in email/i);
    // The old one is what makes the message make sense to someone who
    // did not ask for the change.
    expect(html).toContain('sara@old.example');
    expect(html).toContain('sara@new.example');
    expect(html).toContain('https://lumen.test/login.html');
    // Nothing in this flow touches the password, and saying so stops the
    // teacher hunting for one that was never sent.
    expect(html).toMatch(/password has not changed/i);
  });
});

describe('where a reply goes', () => {
  it('sets reply-to from the environment', async () => {
    // Mail has to be sent from a domain the sender owns, which usually
    // means no-reply@ — but a parent answering a progress report is
    // replying to a person.
    process.env.BREVO_REPLY_TO = 'teacher@example.com';
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail({ to: 'a@b.com', subject: 'Hi', html: 'x' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.replyTo).toEqual({ email: 'teacher@example.com' });
    delete process.env.BREVO_REPLY_TO;
  });

  it('leaves it off when nothing is configured', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail({ to: 'a@b.com', subject: 'Hi', html: 'x' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).replyTo).toBeUndefined();
  });
});

describe('an address on the blocklist', () => {
  // Brevo refuses everything to a blocklisted address, including the
  // link a student is waiting on, and it gets there by bouncing once or
  // by anybody pressing "spam". The teacher can neither see that list
  // nor be expected to.
  const blocked = { ok: false, status: 400, json: async () => ({ message: 'blocked : due to blacklist user' }) };
  const fine = { ok: true, json: async () => ({ messageId: '1' }) };

  it('takes it off the list and sends again', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'DELETE') return { ok: true, json: async () => ({}) };
      return calls.filter(c => c.startsWith('POST')).length === 1 ? blocked : fine;
    }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hush = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await sendEmail({ to: 'sara@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    // `found` names what was actually cleared, as opposed to what was
    // asked: a 404 from a list is not an entry removed from it.
    expect(out).toMatchObject({ sent: true, unblocked: true });
    expect(out.found).toMatch(/transactional blocklist/);
    // Both lists, because Brevo refuses with the same sentence whichever
    // one the address is on, and they are cleared in different places.
    expect(calls).toContain('DELETE https://api.brevo.com/v3/smtp/blockedContacts/sara%40example.com');
    expect(calls).toContain('PUT https://api.brevo.com/v3/contacts/sara%40example.com');
    // send, ask why, clear both lists, send.
    expect(calls).toHaveLength(5);

    quiet.mockRestore(); hush.mockRestore();
  });

  it('clears the flag on a contact when that is what is blocking', async () => {
    // The case that looks identical from outside and is cleared
    // somewhere else: an address with no entry on the transactional
    // list, but a contact carrying emailBlacklisted.
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      seen.push(init.method);
      if (init.method === 'DELETE') return { ok: false, status: 404, json: async () => ({}) };
      if (init.method === 'PUT') return { ok: true, json: async () => ({}) };
      return seen.filter(m => m === 'POST').length === 1 ? blocked : fine;
    }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hush = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await sendEmail({ to: 'sara@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    // A 404 from one list is not a failure: it says there was nothing
    // of that kind to clear. What it must not do is claim to have
    // cleared it.
    expect(out).toMatchObject({ sent: true, unblocked: true });
    expect(out.found).toBe('a blacklisted contact');

    quiet.mockRestore(); hush.mockRestore();
  });

  it('names an account-level block when the address is on no list', async () => {
    // The contradiction a teacher actually meets: Brevo says "blocked"
    // and the blocklist is empty. That is a block on the sending
    // account — an unverified sender, a daily limit, a suspension —
    // and no amount of unblocking a recipient will move it.
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init.method !== 'POST') return { ok: false, status: 404, json: async () => ({}) };
      return blocked;
    }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await sendEmail({ to: 'sara@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    expect(out.sent).toBe(false);
    expect(out.error).toMatch(/neither of its blocklists/i);
    expect(out.error).toMatch(/sending account, not on the recipient/i);
    // And it does not tell them to go looking at the recipient.
    expect(out.error).not.toMatch(/does not exist/i);

    quiet.mockRestore();
  });

  it('gives up after one retry rather than hammering a dead address', async () => {
    // An address that does not exist will bounce again, and retrying
    // that forever is how a sending domain earns a reputation it cannot
    // spend.
    const fetchMock = vi.fn(async (url, init) =>
      init.method === 'DELETE' ? { ok: true, json: async () => ({}) } : blocked);
    vi.stubGlobal('fetch', fetchMock);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await sendEmail({ to: 'sara@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    expect(out.sent).toBe(false);
    // send, ask why, clear both lists, send. And then stop.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(out.error).toMatch(/does not exist/i);

    quiet.mockRestore();
  });

  it('will not clear a hard bounce, and says the address does not exist', async () => {
    // The one that started all this. Gmail answers a send to a mailbox
    // that is not there with "550 5.1.1 ... does not exist"; Brevo
    // records a hard bounce and blocklists the address; and clearing
    // that only sends another message to nowhere, collects another
    // bounce, and spends the sending domain's reputation on a typo.
    const fetchMock = vi.fn(async (url, init) => {
      if (init.method === 'GET') {
        return { ok: true, json: async () => ({ contacts: [{ reason: { code: 'hardBounce' } }] }) };
      }
      return blocked;
    });
    vi.stubGlobal('fetch', fetchMock);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hush = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await sendEmail({ to: 'nobody@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    expect(out.sent).toBe(false);
    expect(out.blockReason).toBe('hardBounce');
    expect(out.error).toMatch(/does not exist/i);
    expect(out.error).toMatch(/typo/i);
    // One send, one question, and no second send at all.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(c => c[1].method === 'DELETE')).toBe(false);

    quiet.mockRestore(); hush.mockRestore();
  });

  it('will not clear a spam report either', async () => {
    // Somebody asking not to be written to. That answer is theirs.
    vi.stubGlobal('fetch', vi.fn(async (url, init) => init.method === 'GET'
      ? { ok: true, json: async () => ({ contacts: [{ reason: { code: 'spam' } }] }) }
      : blocked));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hush = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await sendEmail({ to: 'cross@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    expect(out.error).toMatch(/reported an earlier Lumen email as spam/i);

    quiet.mockRestore(); hush.mockRestore();
  });

  it('leaves an ordinary refusal alone', async () => {
    // Only a blocklist refusal is worth unblocking for. Anything else
    // is reported as it came.
    const fetchMock = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ message: 'sender not verified' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await sendEmail({ to: 'sara@example.com', subject: 'Hi', html: '<p>Hi</p>' });

    expect(out).toEqual({ sent: false, error: 'sender not verified' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    quiet.mockRestore();
  });
});

describe('what a refusal is turned into', () => {
  it('explains a blocklisted address that could not be freed', () => {
    // Only reached when unblocking and resending both failed, so the
    // advice is what is left rather than "go and clear it yourself" —
    // that part is done in code now.
    const out = explain('blocked : due to blacklist user');

    expect(out).toMatch(/blocklist/i);
    expect(out).toMatch(/does not exist/i);
    expect(out).toMatch(/send them the link yourself/i);
  });

  it('passes an unfamiliar refusal through as it came', () => {
    // Summarising a message nobody predicted into "something went
    // wrong" throws away the only clue there is.
    expect(explain('Key not found')).toBe('Key not found');
  });

  it('survives a refusal with nothing in it', () => {
    expect(explain(undefined)).toBe('');
  });
});

describe('loginUrlFor', () => {
  it('prefers PUBLIC_URL', () => {
    configure({ url: 'https://lumen.education/' });
    expect(loginUrlFor({ headers: { host: 'whatever' } })).toBe('https://lumen.education/login.html');
  });

  it('tolerates PUBLIC_URL without a scheme', () => {
    // This field gets edited by hand whenever the domain changes, and a
    // missing https:// would otherwise produce a dead link in every email.
    configure({ url: 'lumen.education' });
    expect(loginUrlFor({ headers: { host: 'x' } })).toBe('https://lumen.education/login.html');
  });

  it('falls back to the host the request came in on', () => {
    // Leaving PUBLIC_URL unset is deliberate-friendly: links follow the
    // domain actually used, so they stay right across a domain move.
    expect(loginUrlFor({ headers: { host: 'lumen.vercel.app' } })).toBe('https://lumen.vercel.app/login.html');
    expect(loginUrlFor({ headers: { host: 'lumen.education' } })).toBe('https://lumen.education/login.html');
  });

  it('uses http for local development', () => {
    expect(loginUrlFor({ headers: { host: 'localhost:3000' } })).toBe('http://localhost:3000/login.html');
  });
});
