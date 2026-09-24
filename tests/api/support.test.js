import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));

// The mail provider is replaced so nothing leaves the machine and the
// handler's two halves — send, and file — can fail independently.
const sent = [];
let sendResult = { sent: true };
vi.mock('../../api/_lib/email.js', () => ({
  sendEmail: async (args) => { sent.push(args); return sendResult; },
  emailStatus: () => ({ ready: true }),
}));

import {
  resetSupabaseMock, configureSupabaseMock, getSupabaseCalls,
  STUDENT_USER, TEACHER_USER, TEACHER_ID,
} from '../helpers/supabase-mock.js';
import { asUser } from '../helpers/as.js';
import { makeReq, makeRes } from '../helpers/http.js';
import handler from '../../api/support.js';

const GOOD = { name: 'Sara Farid', message: 'The PDF on lesson 3 will not open on my phone.', kind: 'technical' };

async function call(body) {
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return res;
}

beforeEach(() => {
  resetSupabaseMock();
  asUser(STUDENT_USER);
  sent.length = 0;
  sendResult = { sent: true };
  delete process.env.SUPPORT_EMAIL;
});

describe('sending a help request', () => {
  it('emails Lumen, with the student as the reply-to', async () => {
    const res = await call(GOOD);

    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('lumenacademy21@gmail.com');
    // Hitting reply in the inbox has to write back to the student.
    expect(sent[0].replyTo).toBe(STUDENT_USER.email);
    expect(sent[0].subject).toMatch(/Sara Farid/);
    expect(sent[0].html).toMatch(/will not open on my phone/);
  });

  it('files the row as well', async () => {
    await call(GOOD);

    const [row] = getSupabaseCalls('support_requests.insert');
    expect(row.payload).toMatchObject({
      teacher_id: TEACHER_ID, student_id: STUDENT_USER.id, name: 'Sara Farid', kind: 'technical',
    });
  });

  it('still emails when the table is missing', async () => {
    // A space that has not run migration v4. This is the case the
    // endpoint exists for, so the email must go regardless.
    configureSupabaseMock({ results: {
      'support_requests.insert': { data: null, error: { message: "Could not find the table 'public.support_requests'" } },
    } });

    const res = await call(GOOD);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: true, filed: false });
    expect(sent).toHaveLength(1);
  });

  it('still files when the mail provider is down', async () => {
    sendResult = { sent: false, error: 'Brevo returned 500' };

    const res = await call(GOOD);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: false, filed: true });
  });

  it('fails only when the message would go nowhere at all', async () => {
    sendResult = { sent: false, error: 'BREVO_API_KEY is not set' };
    configureSupabaseMock({ results: {
      'support_requests.insert': { data: null, error: { message: 'no such table' } },
    } });

    const res = await call(GOOD);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/could not send/i);
  });

  it('sends to the inbox named in the environment when there is one', async () => {
    process.env.SUPPORT_EMAIL = 'help@example.com';
    await call(GOOD);
    expect(sent[0].to).toBe('help@example.com');
  });

  it('refuses a message with nothing in it', async () => {
    const res = await call({ ...GOOD, message: 'hi' });

    expect(res.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('refuses an unsigned request', async () => {
    const res = makeRes();
    await handler(makeReq({ body: GOOD, token: '' }), res);

    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('takes one from a teacher too', async () => {
    // Staff get stuck on a page as easily as students do.
    asUser(TEACHER_USER);
    const res = await call(GOOD);
    expect(res.statusCode).toBe(200);
  });

  it('falls back to "Something else" for a kind it does not know', async () => {
    await call({ ...GOOD, kind: 'nonsense' });
    expect(sent[0].subject).toMatch(/Something else/);
  });
});
