import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// supabase-setup.sql is run top to bottom in one go, and Postgres will
// not let you reference something that does not exist yet. A
// SQL-language function is the easy one to get wrong: its body is
// checked when the function is created, so a helper defined near the top
// that reads a table created near the bottom fails the whole script with
// `relation "public.x" does not exist` — which is only discovered by
// someone pasting the file into a fresh project.
//
// These checks read the file the way Postgres does: in order.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sqlFiles() {
  return readdirSync(ROOT)
    .filter(f => f.startsWith('supabase-') && f.endsWith('.sql'))
    .map(f => ({ name: f, sql: readFileSync(join(ROOT, f), 'utf8') }));
}

const SETUP = readFileSync(join(ROOT, 'supabase-setup.sql'), 'utf8');

// Offsets rather than line numbers, so "before" is exact.
function positionsOf(sql, re, group = 1) {
  const found = new Map();
  for (const m of sql.matchAll(re)) {
    const name = m[group].toLowerCase();
    if (!found.has(name)) found.set(name, m.index);
  }
  return found;
}

const tables = positionsOf(SETUP, /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+public\.(\w+)/gi);
const functions = positionsOf(SETUP, /CREATE OR REPLACE FUNCTION\s+public\.(\w+)/gi);

// Everything the file defines, so a reference to something Supabase
// already provides (auth.users, storage.objects) is not mistaken for a
// forward reference.
const defined = new Set([...tables.keys()]);

describe('supabase-setup.sql runs top to bottom', () => {
  it('defines the tables the whole schema is built from', () => {
    for (const t of ['teachers', 'profiles', 'courses', 'enrollments', 'practice_tests']) {
      expect(tables.has(t), `missing table ${t}`).toBe(true);
    }
  });

  it('creates every table before a foreign key points at it', () => {
    for (const m of SETUP.matchAll(/REFERENCES\s+public\.(\w+)\s*\(/gi)) {
      const target = m[1].toLowerCase();
      if (!defined.has(target)) continue;                 // provided by Supabase
      expect(tables.get(target), `REFERENCES public.${target} at ${m.index} comes before its CREATE TABLE`)
        .toBeLessThan(m.index);
    }
  });

  it('creates every table before a policy is put on it', () => {
    for (const m of SETUP.matchAll(/CREATE POLICY\s+"[^"]+"\s+ON\s+public\.(\w+)/gi)) {
      const target = m[1].toLowerCase();
      expect(tables.has(target), `policy on unknown table public.${target}`).toBe(true);
      expect(tables.get(target), `policy on public.${target} at ${m.index} comes before its CREATE TABLE`)
        .toBeLessThan(m.index);
    }
  });

  // The one that actually bit: a SQL-language function's body is
  // validated at creation time.
  it('creates every table a function body reads before that function', () => {
    const bodies = [...SETUP.matchAll(
      /CREATE OR REPLACE FUNCTION\s+public\.(\w+)[\s\S]*?\$\$([\s\S]*?)\$\$/gi)];
    expect(bodies.length).toBeGreaterThan(5);

    for (const [, fnName, body] of bodies) {
      const fnAt = functions.get(fnName.toLowerCase());
      for (const ref of body.matchAll(/\bpublic\.(\w+)\b/gi)) {
        const target = ref[1].toLowerCase();
        if (functions.has(target)) {
          expect(functions.get(target), `public.${fnName}() calls public.${target}() before it is defined`)
            .toBeLessThan(fnAt);
          continue;
        }
        if (!defined.has(target)) continue;
        expect(tables.get(target), `public.${fnName}() reads public.${target} before its CREATE TABLE`)
          .toBeLessThan(fnAt);
      }
    }
  });

  it('defines every function before a policy calls it', () => {
    for (const m of SETUP.matchAll(/CREATE POLICY[\s\S]*?;/gi)) {
      for (const call of m[0].matchAll(/public\.(\w+)\s*\(/gi)) {
        const fn = call[1].toLowerCase();
        if (!functions.has(fn)) continue;
        expect(functions.get(fn), `a policy at ${m.index} calls public.${fn}() before it is defined`)
          .toBeLessThan(m.index);
      }
    }
  });

  // Plain ON DELETE SET NULL nulls every column of the referencing key,
  // not just the one that pointed at the deleted row. On a composite key
  // that pairs a child with its parent — (group_id, course_id) — that
  // means deleting a group asks to null course_id too, and course_id is
  // NOT NULL, so the delete is refused with an error naming a column
  // nobody touched. Postgres 15's column list is the fix, and it is
  // invisible when missing until someone deletes a group.
  it('names the column on every composite ON DELETE SET NULL', () => {
    const composite = /FOREIGN KEY\s*\(\s*\w+\s*,[^)]*\)\s*REFERENCES\s+public\.\w+\s*\([^)]*\)\s*ON DELETE SET NULL\s*(\()?/gi;
    for (const m of SETUP.matchAll(composite)) {
      expect(m[1], `a composite foreign key at ${m.index} uses bare ON DELETE SET NULL, `
        + 'which nulls every column of the key — name the nullable one, e.g. SET NULL (group_id)')
        .toBe('(');
    }
  });

  it('enables row-level security on every table it creates', () => {
    // A table with policies but no ENABLE ROW LEVEL SECURITY is wide
    // open, and looks locked down at a glance.
    const enabled = positionsOf(SETUP, /ALTER TABLE\s+public\.(\w+)\s+ENABLE ROW LEVEL SECURITY/gi);
    for (const [table, at] of tables) {
      expect(enabled.has(table), `public.${table} never has RLS enabled`).toBe(true);
      expect(at, `public.${table} has RLS enabled before it is created`).toBeLessThan(enabled.get(table));
    }
  });
});

// The README promises that a fresh project needs supabase-setup.sql and
// nothing else: "A fresh project does not: the setup file already
// contains what they add." That is an invariant somebody has to keep by
// hand on every migration, and forgetting it is invisible — the running
// project is fine, and only a rebuilt one comes up missing a table.
describe('supabase-setup.sql absorbs every migration', () => {
  const migrations = sqlFiles().filter(f => /^supabase-migration-v\d+\.sql$/.test(f.name));

  it('finds the migrations', () => {
    expect(migrations.length).toBeGreaterThan(5);
  });

  it.each(migrations)('$name — every table it creates is in the setup file', ({ sql }) => {
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+public\.(\w+)/gi)) {
      expect(tables.has(m[1].toLowerCase()), `public.${m[1]} is created by a migration but not by setup`).toBe(true);
    }
  });

  it.each(migrations)('$name — every function it defines is in the setup file', ({ sql }) => {
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.(\w+)/gi)) {
      expect(functions.has(m[1].toLowerCase()), `public.${m[1]}() is defined by a migration but not by setup`).toBe(true);
    }
  });

  it.each(migrations)('$name — every column it adds is in the setup file', ({ sql }) => {
    for (const m of sql.matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)) {
      expect(SETUP, `column ${m[1]} is added by a migration but not by setup`)
        .toMatch(new RegExp(`\\b${m[1]}\\b`));
    }
  });

  it.each(migrations)('$name — every trigger it creates is in the setup file', ({ sql }) => {
    for (const m of sql.matchAll(/CREATE TRIGGER\s+(\w+)/gi)) {
      expect(SETUP, `trigger ${m[1]} is created by a migration but not by setup`)
        .toMatch(new RegExp(`CREATE TRIGGER\\s+${m[1]}\\b`, 'i'));
    }
  });

  it.each(migrations)('$name — every unique index it creates is in the setup file', ({ sql }) => {
    // The ones that enforce a rule rather than speed a lookup. A rebuilt
    // project missing one of these collects exactly the duplicates the
    // migration existed to stop.
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)) {
      expect(SETUP, `unique index ${m[1]} is created by a migration but not by setup`)
        .toMatch(new RegExp(`\\b${m[1]}\\b`));
    }
  });
});

describe('every supabase-*.sql file', () => {
  // Setup having the column list is not enough. A migration is replayed
  // on a database the later ones have already reached — the README says
  // to run them in order and that each is safe to run twice — so a
  // migration still carrying bare SET NULL silently undoes v14 the next
  // time anybody runs it. That is exactly how this came back once.
  it.each(sqlFiles())('$name names the column on every composite ON DELETE SET NULL', ({ sql }) => {
    const composite = /FOREIGN KEY\s*\(\s*\w+\s*,[^)]*\)\s*REFERENCES\s+public\.\w+\s*\([^)]*\)\s*ON DELETE SET NULL\s*(\()?/gi;
    for (const m of sql.matchAll(composite)) {
      expect(m[1], `a composite foreign key at ${m.index} uses bare ON DELETE SET NULL, `
        + 'which nulls every column of the key — name the nullable one, e.g. SET NULL (group_id)')
        .toBe('(');
    }
  });

  it.each(sqlFiles())('$name has balanced dollar-quoted blocks', ({ sql }) => {
    // An odd number of $$ means a function body or DO block was left
    // open, which swallows the rest of the file.
    expect((sql.match(/\$\$/g) || []).length % 2).toBe(0);
  });

  it.each(sqlFiles())('$name uses no psql-only syntax', ({ sql }) => {
    // The Supabase SQL editor is not psql: \set and friends are errors
    // there, not variables.
    expect(sql).not.toMatch(/^\s*\\\w+/m);
  });
});
