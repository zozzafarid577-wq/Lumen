import { describe, it, expect } from 'vitest';
import { generatePassword, cleanEmail, cleanName, cleanSlug, cleanText } from '../../api/_lib/util.js';

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
    expect(cleanSlug('Dr Mai Abd El Salam')).toBe('dr-mai-abd-el-salam');
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
