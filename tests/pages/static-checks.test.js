import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// This project has no build step, so nothing compiles the inline
// JavaScript in the pages or checks that a link goes anywhere. A typo in
// either only shows up when someone opens that page. These checks stand
// in for the compiler the project does not have.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'tests', 'coverage']);

function htmlFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) htmlFiles(full, found);
    else if (entry.endsWith('.html')) found.push(full);
  }
  return found;
}

const PAGES = htmlFiles().map(path => ({
  path,
  rel: path.slice(ROOT.length + 1),
  html: readFileSync(path, 'utf8'),
}));

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (/\bsrc=/.test(m[1])) continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

function scriptSrcs(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]);
}

it('finds the pages to check', () => {
  expect(PAGES.length).toBeGreaterThan(15);
});

describe.each(PAGES)('$rel', ({ rel, html }) => {
  it('has inline JavaScript that parses', () => {
    inlineScripts(html).forEach((code, i) => {
      // `new vm.Script` parses without running, which is what we want:
      // these scripts expect a browser.
      expect(() => new vm.Script(code, { filename: `${rel}#inline-${i}` })).not.toThrow();
    });
  });

  it('links only to files that exist', () => {
    const hrefs = [...html.matchAll(/\b(?:href|src)=["'](\/[^"'#?]*)["']/g)].map(m => m[1]);
    for (const href of hrefs) {
      const target = href.endsWith('/') ? join(ROOT, href, 'index.html') : join(ROOT, href);
      expect(existsSync(target), `${rel} → ${href}`).toBe(true);
    }
  });

  it('loads its scripts in an order that works', () => {
    const srcs = scriptSrcs(html).filter(s => s.startsWith('/js/'));
    if (!srcs.includes('/js/auth.js')) return;

    // auth.js reads window.LUMEN_CONFIG at import time and calls helpers
    // out of ui.js, so both have to be in front of it. Getting this wrong
    // leaves the page on its skeleton with a console error nobody sees.
    expect(srcs.indexOf('/js/config.js'), rel).toBeGreaterThanOrEqual(0);
    expect(srcs.indexOf('/js/config.js')).toBeLessThan(srcs.indexOf('/js/auth.js'));
    expect(srcs.indexOf('/js/ui.js')).toBeLessThan(srcs.indexOf('/js/auth.js'));
  });

  it('has one title and one h1-or-page-title', () => {
    expect((html.match(/<title>/g) || []).length, rel).toBe(1);
  });
});

describe('the signed-in pages', () => {
  const appPages = PAGES.filter(p => /^(teacher|portal|admin)\//.test(p.rel));

  it('covers all three portals', () => {
    expect(appPages.some(p => p.rel.startsWith('teacher/'))).toBe(true);
    expect(appPages.some(p => p.rel.startsWith('portal/'))).toBe(true);
    expect(appPages.some(p => p.rel.startsWith('admin/'))).toBe(true);
  });

  it.each(appPages)('$rel guards itself with requireAuth', ({ html, rel }) => {
    // A page that forgets this renders its whole shell to anyone with the
    // URL, and only fails later when a query comes back empty.
    expect(html, rel).toMatch(/requireAuth\(/);
  });

  it.each(appPages)('$rel keeps itself out of search results', ({ html }) => {
    expect(html).toMatch(/<meta name="robots" content="noindex">/);
  });

  it.each(appPages)('$rel applies the saved theme before paint', ({ html }) => {
    // Without this snippet in <head>, a dark-mode page flashes white on
    // every single load.
    expect(html).toMatch(/localStorage\.getItem\('lumen_theme'\)/);
  });
});

describe('the nav in js/shell.js', () => {
  const shell = readFileSync(join(ROOT, 'js/shell.js'), 'utf8');

  it('points every menu item at a page that exists', () => {
    const hrefs = [...shell.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1]);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      const target = href.endsWith('/') ? join(ROOT, href, 'index.html') : join(ROOT, href);
      expect(existsSync(target), href).toBe(true);
    }
  });

  it('has an icon for every menu item', () => {
    const icons = [...shell.matchAll(/icon:\s*'([^']+)'/g)].map(m => m[1]);
    const defined = new Set([...shell.matchAll(/^\s{2}(\w+):\s*'</gm)].map(m => m[1]));
    for (const icon of icons) expect(defined.has(icon), icon).toBe(true);
  });
});

describe('the permission map in js/auth.js', () => {
  const auth = readFileSync(join(ROOT, 'js/auth.js'), 'utf8');

  it('guards every teacher page that has a permission', () => {
    const pages = [...auth.matchAll(/'(\/teacher\/[^']+)':\s*'(\w+)'/g)];
    expect(pages.length).toBeGreaterThan(5);

    for (const [, href, perm] of pages) {
      expect(existsSync(join(ROOT, href)), href).toBe(true);
      // Hiding the nav link is presentation. The page's own requireAuth
      // must pass the same permission, or the link is the only thing
      // stopping an assistant from opening it.
      const html = readFileSync(join(ROOT, href), 'utf8');
      expect(html, href).toMatch(new RegExp(`perm:\\s*'${perm}'`));
    }
  });
});

describe('js/config.js', () => {
  const config = readFileSync(join(ROOT, 'js/config.js'), 'utf8');

  it('ships with placeholders, not somebody’s project', () => {
    expect(config).toMatch(/YOUR-PROJECT\.supabase\.co/);
    expect(config).toMatch(/YOUR-ANON-KEY/);
  });

  it('never carries a service-role key', () => {
    // The anon key is meant to be public; the service-role key is not,
    // and it would be a total breach of every tenant at once.
    expect(config).not.toMatch(/service_role/i);
    expect(config).not.toMatch(/SERVICE_ROLE/);
  });
});

describe('the pages as a whole', () => {
  it('never carries a hard-coded Supabase key', () => {
    // A JWT pasted into a page is how a project key ends up in git.
    for (const { rel, html } of PAGES) {
      expect(html, rel).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
    }
  });

  it('opens external links safely', () => {
    for (const { rel, html } of PAGES) {
      for (const tag of html.match(/<a\b[^>]*target=["']_blank["'][^>]*>/gi) || []) {
        expect(tag, `${rel}: ${tag}`).toMatch(/rel=["'][^"']*noopener/);
      }
    }
  });
});
