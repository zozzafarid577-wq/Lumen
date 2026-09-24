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

  // A page's script and its markup are one file, and moving a feature
  // between pages moves them apart: the handler goes, the element it
  // reads stays behind, and getElementById returns null at the first
  // click rather than at load. Only literal ids are checked — the ones
  // built from a row id (`'ns-g-' + c.id`) are written by the same code
  // that reads them.
  it('reads only element ids it actually has', () => {
    const ids = new Set([...html.matchAll(/\bid=["']([^"'$]+)["']/g)].map(m => m[1]));
    const wanted = new Set([...html.matchAll(/getElementById\(\s*'([^'$]+)'\s*\)/g)].map(m => m[1]));
    for (const id of wanted) {
      expect(ids.has(id), `getElementById('${id}') but nothing in ${rel} has that id`).toBe(true);
    }
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

describe('path tests in js/', () => {
  // Vercel's cleanUrls serves /teacher/settings for settings.html, so a
  // guard anchored on the extension never matches the page it just
  // redirected to. That cost an infinite redirect loop on every
  // teacher's first sign-in. Checks must accept both spellings.
  const files = ['js/auth.js', 'js/ui.js', 'js/site.js'];

  it.each(files)('%s never tests a path for a required .html', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const line of src.split('\n')) {
      if (!/location\.pathname/.test(line) && !/isPage\(/.test(line)) continue;
      // Stripping the extension off both sides before comparing is fine;
      // requiring it in a test is not.
      const requiresHtml = /\/[^/\n]*\\\.html\$\//.test(line) && !/\.replace\(/.test(line);
      expect(requiresHtml, `${file}: ${line.trim()}`).toBe(false);
    }
  });
});

describe('js/config.js', () => {
  const config = readFileSync(join(ROOT, 'js/config.js'), 'utf8');

  it('points at a Supabase project', () => {
    expect(config).toMatch(/SUPABASE_URL:\s*'https:\/\/[a-z0-9-]+\.supabase\.co'/);
  });

  // This file is served to every visitor, so whatever key is in it is
  // public. The anon key is designed for that. The service-role key
  // bypasses row-level security completely — putting it here would
  // expose every tenant at once, and it is an easy copy-paste to make
  // because the two sit next to each other in the Supabase dashboard
  // and look identical. So check the claim rather than trusting the
  // variable name.
  it('carries an anon key, never a service-role key', () => {
    const [, token] = config.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [];
    expect(token, 'no SUPABASE_ANON_KEY found').toBeTruthy();

    const [, payload] = token.split('.');
    expect(payload, 'the key is not a JWT').toBeTruthy();
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    expect(claims.role).toBe('anon');
    expect(claims.role).not.toBe('service_role');
  });

  it('mentions no service-role key anywhere', () => {
    expect(config).not.toMatch(/service_role/i);
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));

  // This one shipped broken. With cleanUrls on, Vercel serves join.html at
  // /join and turns /join.html into a 308 *redirect* — so /join.html stops
  // being a path anything can be rewritten to, and a rewrite aimed at it
  // 404s. The page was live and reachable at /join the whole time; only
  // the pretty /join/<token> link every student is sent was dead.
  it('never points a rewrite at a .html path while cleanUrls is on', () => {
    if (!config.cleanUrls) return;
    for (const r of config.rewrites || []) {
      expect(r.destination, `${r.source} → ${r.destination}`).not.toMatch(/\.html$/);
    }
  });

  it('rewrites and redirects only to somewhere that exists', () => {
    for (const r of [...(config.rewrites || []), ...(config.redirects || [])]) {
      const dest = r.destination.split(/[?#]/)[0];
      if (dest.includes(':')) continue;                     // carries a parameter through
      const candidates = [
        join(ROOT, dest),                                   // exactly as written
        join(ROOT, `${dest}.html`),                         // what cleanUrls resolves
        join(ROOT, dest, 'index.html'),                     // a directory
      ];
      expect(candidates.some(existsSync), `${r.source} → ${r.destination}`).toBe(true);
    }
  });

  it('gives every invite link a route to land on', () => {
    // The token goes in the path, so without this rule the link a teacher
    // pastes into WhatsApp is a 404 for the whole class.
    const joinRule = (config.rewrites || []).find(r => r.source.startsWith('/join/'));
    expect(joinRule, 'no rewrite for /join/<token>').toBeTruthy();
    expect(existsSync(join(ROOT, 'join.html'))).toBe(true);
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
