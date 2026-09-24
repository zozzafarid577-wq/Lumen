import { randomInt } from 'node:crypto';
import { HttpError } from './auth.js';

// A first password is read off a screen and typed into a phone, so the
// alphabet leaves out the characters people confuse (O/0, l/1/I) — and
// randomInt is used rather than Math.random because this is a credential.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGIT = '23456789';
const EXTRA = '!@#$%&*';

export function generatePassword(length = 12) {
  const all = UPPER + LOWER + DIGIT + EXTRA;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(EXTRA)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates, so the guaranteed one-of-each characters do not always
  // land in the first four positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function pick(set) { return set[randomInt(set.length)]; }

// The random part of an invite link. Same unambiguous alphabet as a
// password, for the same reason: this gets read off one screen and typed
// into another, or dictated down a phone. 10 characters of it is about
// 52 bits — far past guessing a live one, which matters because knowing
// a token is all it takes to submit a registration.
export function generateToken(length = 10) {
  const all = UPPER + LOWER + DIGIT;
  let out = '';
  for (let i = 0; i < length; i++) out += pick(all);
  return out;
}

// "Is this the same phone number?" — the last 9 digits of it, which is
// what makes +20 101 234 5678 and 01012345678 the same person.
//
// This MUST agree with the generated phone_key column in
// supabase-migration-v11.sql: that column is what the unique index
// enforces, and this is what the handler checks first so the student
// gets a sentence instead of a constraint violation. If one changes,
// change both.
export function phoneKey(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

export function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'That email address does not look right.');
  return email;
}

export function cleanName(value, field = 'Name') {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2)  throw new HttpError(400, `${field} is required.`);
  if (name.length > 120) throw new HttpError(400, `${field} is too long.`);
  return name;
}

export function cleanText(value, { max = 2000 } = {}) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

// A teacher's space is named by its slug, which shows up in URLs and in
// the sign-in hint their students are given.
export function cleanSlug(value) {
  const slug = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (slug.length < 3) throw new HttpError(400, 'Choose a space name of at least 3 letters.');
  if (RESERVED_SLUGS.has(slug)) throw new HttpError(400, 'That space name is not available.');
  return slug;
}

// Paths the site itself uses. A teacher whose slug is "admin" would make
// their own space unreachable.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'assets', 'css', 'js', 'login', 'logout', 'register',
  'portal', 'teacher', 'lumen', 'www', 'help', 'support', 'pricing', 'features', 'contact',
  // Where a batch invite link points. A space slugged "join" would sit on
  // top of every teacher's registration links, not just its own.
  'join',
]);

// Supabase has no "find a user by email" admin call, so this pages
// through the directory. Capped so a bug cannot loop forever.
export async function findUserByEmail(admin, email) {
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new HttpError(502, 'Could not check existing accounts. Please try again.');
    const users = data?.users || [];
    const found = users.find(u => (u.email || '').toLowerCase() === email);
    if (found) return found;
    if (users.length < perPage) break;
  }
  return null;
}
