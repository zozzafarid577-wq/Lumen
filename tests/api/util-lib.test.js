import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generatePassword, generateToken, phoneKey, cleanEmail, cleanName, cleanSlug, cleanText,
} from '../../api/_lib/util.js';

describe('generatePassword', () => {
  it('is long enough and mixed', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(12);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[2-9]/);
      expect(pw).toMatch(/[!@#$%&*]/);
    }
  });

  it('leaves out the characters people misread', () => {
    // These are read off a screen and typed into a phone. O/0 and l/1/I
    // are how a brand-new student concludes their account is broken.
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).not.toMatch(/[O0oIl1]/);
    }
  });

  it('does not always put the guaranteed characters first', () => {
    // Unshuffled, every password would read Upper-lower-digit-symbol.
    const firsts = new Set(Array.from({ length: 100 }, () => generatePassword()[0]));
    expect(firsts.size).toBeGreaterThan(4);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });
});

describe('generateToken', () => {
  it('is long enough to be unguessable', () => {
    // Knowing a live token is all it takes to reach a registration form,
    // so this is a credential, not an id.
    expect(generateToken()).toHaveLength(10);
    const seen = new Set(Array.from({ length: 2000 }, () => generateToken()));
    expect(seen.size).toBe(2000);
  });

  it('survives being read aloud and typed back', () => {
    // It goes into a WhatsApp message and onto a whiteboard. Same reason
    // the password alphabet drops these: O/0 and l/1/I.
    for (let i = 0; i < 300; i++) {
      const t = generateToken();
      expect(t).toMatch(/^[A-Za-z0-9]+$/);
      expect(t).not.toMatch(/[O0oIl1]/);
    }
  });

  it('is safe to put straight in a URL path', () => {
    // It is interpolated into /join/<token> with no escaping, on the
    // server and again in the browser.
    for (let i = 0; i < 100; i++) {
      const t = generateToken();
      expect(encodeURIComponent(t)).toBe(t);
    }
  });
});

describe('phoneKey', () => {
  it('reads one number written every way a person writes it', () => {
    // This is the whole "you already registered" check for phone numbers.
    const same = ['+20 101 234 5678', '00201012345678', '01012345678', '0101-234-5678', '(0101) 234 5678'];
    const keys = new Set(same.map(phoneKey));
    expect(keys.size, [...keys].join(' / ')).toBe(1);
  });

  it('keeps different numbers different', () => {
    expect(phoneKey('01012345678')).not.toBe(phoneKey('01087654321'));
  });

  it('ignores something too short to be a phone number', () => {
    // Otherwise "123" would collide with every number ending in 123.
    for (const bad of ['', null, undefined, '123', '12-34', 'n/a']) {
      expect(phoneKey(bad), String(bad)).toBeNull();
    }
  });

  // The unique index in migration v11 is what actually enforces
  // registering once; this function only exists so the student gets a
  // sentence instead of a constraint violation. If the two ever disagree,
  // the handler waves somebody through and the database then refuses
  // them with a 500.
  it('agrees with the generated column in the migration', () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const sql = readFileSync(join(ROOT, 'supabase-migration-v11.sql'), 'utf8');
    const column = sql.slice(sql.indexOf('phone_key'), sql.indexOf('STORED,', sql.indexOf('phone_key')));

    expect(column).toMatch(/LENGTH\(REGEXP_REPLACE\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\)\) >= 7/);
    expect(column).toMatch(/RIGHT\(REGEXP_REPLACE\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\), 9\)/);

    // And the same two numbers on this side.
    expect(phoneKey('1234567')).toHaveLength(7);
    expect(phoneKey('123456')).toBeNull();
    expect(phoneKey('1234567890123')).toBe('567890123');
  });
});

describe('cleanEmail', () => {
  it('lowercases and trims', () => {
    expect(cleanEmail('  Sara@Example.COM ')).toBe('sara@example.com');
  });

  it('rejects what is not an address', () => {
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@example.com', null]) {
      expect(() => cleanEmail(bad), String(bad)).toThrow();
    }
  });
});

describe('cleanName', () => {
  it('collapses runs of whitespace', () => {
    expect(cleanName('  Sara   Ahmed  ')).toBe('Sara Ahmed');
  });

  it('rejects one that is too short or too long', () => {
    expect(() => cleanName('A')).toThrow();
    expect(() => cleanName('x'.repeat(200))).toThrow();
  });
});

describe('cleanSlug', () => {
  it('makes a URL-safe name', () => {
    expect(cleanSlug('Advanced Biology Revision')).toBe('advanced-biology-revision');
    expect(cleanSlug('  Bio--101!!  ')).toBe('bio-101');
  });

  it('refuses a name the site itself uses', () => {
    for (const reserved of ['admin', 'API', 'portal', 'teacher', 'login']) {
      expect(() => cleanSlug(reserved), reserved).toThrow(/not available/);
    }
  });

  it('refuses one that comes out too short', () => {
    expect(() => cleanSlug('!!')).toThrow();
    expect(() => cleanSlug('ab')).toThrow();
  });
});

describe('cleanText', () => {
  it('turns blank into null so the column stays empty', () => {
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });

  it('caps the length', () => {
    expect(cleanText('x'.repeat(5000), { max: 100 })).toHaveLength(100);
  });
});
