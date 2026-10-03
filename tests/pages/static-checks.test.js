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
      const path = href.split('?')[0];   // "View as student" carries ?preview=1
      const target = path.endsWith('/') ? join(ROOT, path, 'index.html') : join(ROOT, path);
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
      const path = href.split('?')[0];   // "View as student" carries ?preview=1
      const target = path.endsWith('/') ? join(ROOT, path, 'index.html') : join(ROOT, path);
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

// Picking questions in the bank and building a test out of them is one
// job split across two pages, joined by a sessionStorage key and a query
// string. Neither end fails loudly when the other changes: a renamed key
// just means the builder opens empty, and a mistyped path lands on a
// 404 with the selection already handed over. Nothing else in the suite
// looks at a string inside location.href.
describe('the bank hands a selection to the test builder', () => {
  const page = (rel) => PAGES.find(p => p.rel === rel)?.html || '';
  const BANK = page('teacher/question-bank.html');
  const TESTS = page('teacher/tests.html');
  const KEY = 'lumen_test_seed';

  it('finds both pages', () => {
    expect(BANK.length).toBeGreaterThan(0);
    expect(TESTS.length).toBeGreaterThan(0);
  });

  it('writes the key the builder reads', () => {
    expect(BANK, 'the bank never writes the handover').toMatch(
      new RegExp(`sessionStorage\\.setItem\\(\\s*'${KEY}'`));
    expect(TESTS, 'the builder never reads the handover').toMatch(
      new RegExp(`sessionStorage\\.getItem\\(\\s*'${KEY}'`));
  });

  it('clears the key once it has been read, so a refresh starts clean', () => {
    expect(TESTS).toMatch(new RegExp(`sessionStorage\\.removeItem\\(\\s*'${KEY}'`));
  });

  it('sends the teacher to a page that exists, with the flag it looks for', () => {
    const nav = BANK.match(/location\.href\s*=\s*'([^']+)'/);
    expect(nav, 'the bank never navigates to the builder').toBeTruthy();

    const [path, query] = nav[1].split('?');
    expect(existsSync(join(ROOT, path.replace(/^\//, ''))), `${path} does not exist`).toBe(true);

    // The flag the builder branches on has to be the one being sent.
    const flag = new URLSearchParams(query).get('from');
    expect(flag).toBe('bank');
    expect(TESTS).toMatch(new RegExp(`get\\('from'\\)\\s*===\\s*'${flag}'`));
  });

  it('never lets the bank offer more questions than a test can hold', () => {
    // api/save-test.js refuses more than 300, and finding that out after
    // picking four hundred is finding out too late.
    const capped = BANK.match(/MAX_TEST_QUESTIONS\s*=\s*(\d+)/);
    expect(capped, 'the bank does not cap a selection').toBeTruthy();

    const api = readFileSync(join(ROOT, 'api/save-test.js'), 'utf8');
    const server = api.match(/list\.length\s*>\s*(\d+)/);
    expect(server, 'save-test.js no longer caps the question list').toBeTruthy();
    expect(Number(capped[1]), 'the page and the server disagree about the limit')
      .toBe(Number(server[1]));
  });
});

// A link a teacher pastes into WhatsApp has to name the site Lumen is
// handed out under, not whichever URL that teacher happened to have
// open. Built from location.origin, a teacher working on the
// deployment's own hostname sends students a link twice the length with
// a project name in it — and every one of these is a string inside a
// template literal, so nothing else in the suite would notice.
describe('links a teacher hands to somebody else', () => {
  const config = readFileSync(join(ROOT, 'js/config.js'), 'utf8');
  const ui = readFileSync(join(ROOT, 'js/ui.js'), 'utf8');

  it('has a canonical site to point at', () => {
    expect(ui, 'js/ui.js defines no siteOrigin()').toMatch(/function siteOrigin\(/);

    const set = config.match(/SITE_URL:\s*'([^']*)'/);
    if (!set) return;   // no custom domain yet is allowed; links fall back
    // Origin only. A trailing slash or a path here produces "…site//join"
    // or "…site/app/join", and both are found by a student, not a test.
    expect(set[1], 'SITE_URL must be an origin: no path, no trailing slash')
      .toMatch(/^https?:\/\/[^/]+$/);
  });

  it('falls back to the current origin when no site is configured', () => {
    // A deployment with no custom domain must still produce links that
    // work, rather than links to nowhere.
    expect(ui).toMatch(/if \(!configured\) return location\.origin;/);
  });

  // A batch invite link is still built in the page. A student's set-up
  // link is not: it comes back from the API, which builds it from
  // PUBLIC_URL — see the check below.
  const SHAREABLE = [
    ['teacher/students.html', /function inviteUrl\(token\) \{[^}]*\}/],
    ['teacher/team.html', /Lumen sign-in: \$\{[^}]+\}/],
    ['admin/teachers.html', /Lumen sign-in: \$\{[^}]+\}/],
  ];

  it.each(SHAREABLE)('%s builds its shared link from siteOrigin()', (rel, re) => {
    const html = PAGES.find(p => p.rel === rel)?.html;
    expect(html, `${rel} not found`).toBeTruthy();

    const found = html.match(re);
    expect(found, `${rel} no longer contains the link this checks`).toBeTruthy();
    expect(found[0], `${rel} still builds a shared link from location.origin`)
      .not.toMatch(/location\.origin/);
    expect(found[0]).toMatch(/siteOrigin\(\)/);
  });

  it('never puts a student password in a message a teacher sends', () => {
    // A teacher hands over a link, never a password: they have none to
    // hand over, and a page that starts writing "Password: …" into a
    // WhatsApp message has put back the thing this flow removed.
    //
    // Only the teacher's page. A student copying their own password off
    // their own screen, seconds after typing it, is the opposite thing
    // — it is the written record they were asked to keep — and
    // join.html and set-password.html both do exactly that on purpose.
    const html = PAGES.find(p => p.rel === 'teacher/students.html')?.html;
    expect(html, 'teacher/students.html not found').toBeTruthy();
    expect(html, 'the teacher page is handing over a password again')
      .not.toMatch(/Password: \$\{/);
  });

  it('hands over the set-up link the server built, not one of its own', () => {
    // The API builds it from PUBLIC_URL, so a teacher working from a
    // preview deployment still sends a link to the real site.
    const html = PAGES.find(p => p.rel === 'teacher/students.html').html;
    const text = html.match(/function credentialsText\(c\) \{[\s\S]*?\n\}/)?.[0];
    expect(text, 'credentialsText() is no longer there to check').toBeTruthy();
    expect(text).toMatch(/\$\{c\.url\}/);
    expect(text).not.toMatch(/location\.origin|siteOrigin\(\)/);
  });

  it('stays inside the twelve serverless functions the plan allows', () => {
    // Vercel's Hobby plan builds at most twelve Serverless Functions,
    // and every top-level .js in api/ is one. A thirteenth does not
    // degrade anything: it fails the whole deployment, while the last
    // good one carries on serving — so the site keeps working and
    // silently stops changing, which is a far worse way to find out.
    //
    // That happened. The fix was to route the extra flow from an
    // existing function; api/_lib/ is free, because nothing in there
    // becomes a function.
    const fns = readdirSync(join(ROOT, 'api')).filter(f => f.endsWith('.js'));
    expect(fns.length, `api/ has ${fns.length} functions: ${fns.join(', ')}`)
      .toBeLessThanOrEqual(12);
  });

  it('never sends a live session back to the sign-in page', () => {
    // The shape of an infinite loop, and it has happened: the sign-in
    // page finds a session, hands it to handlePostLogin, that sends it
    // back to the sign-in page, which finds the session again. From the
    // outside it is a page that loads for ever.
    //
    // Whatever the reason for giving up on a session, it has to be
    // ENDED before the reader is sent to a page that will pick it
    // straight back up.
    const auth = readFileSync(join(ROOT, 'js/auth.js'), 'utf8');
    const fn = auth.match(/async function handlePostLogin[\s\S]*?\n\}/)?.[0];
    expect(fn, 'handlePostLogin is no longer there to check').toBeTruthy();

    for (const [, before] of [...fn.matchAll(/([\s\S]*?)location\.replace\('\/login\.html/g)]) {
      expect(before, 'a redirect to sign-in with no signOut() before it')
        .toMatch(/signOut\(\)/);
    }
  });

  it('loads no script from somebody else\u2019s CDN', () => {
    // A third-party script is a DNS lookup, a TLS handshake and a
    // connection to a host the browser has never spoken to, all before
    // the sign-in button works \u2014 on a phone on mobile data, most of a
    // second. It is also a supply chain: whatever they serve, this site
    // runs.
    //
    // One exception, asked for by the owner: Google Analytics. It cannot be
    // vendored — Google serves it per property — so it is allowed by its
    // exact address, and only with `async`, so the page never waits on it.
    const ALLOWED = /^<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+"/;
    for (const { rel, html } of PAGES) {
      const remote = [...html.matchAll(/<script[^>]+src=["'](https?:)?\/\/[^"']+["']/g)]
        .filter(m => !ALLOWED.test(m[0]));
      expect(remote.map(m => m[0]), `${rel} loads a script from another host`).toEqual([]);
    }
  });

  it('points every page at a vendored file that is actually here', () => {
    // The version is in the filename, so an upgrade that misses a page
    // leaves it asking for a file nobody shipped \u2014 and a page whose
    // scripts 404 is a page that does nothing at all.
    for (const { rel, html } of PAGES) {
      for (const [, src] of html.matchAll(/<script[^>]+src=["'](\/assets\/vendor\/[^"']+)["']/g)) {
        expect(existsSync(join(ROOT, src)), `${rel} loads ${src}, which is not in the repo`).toBe(true);
      }
    }
  });

  it('puts nothing in vercel.json that Vercel will not accept', () => {
    // Vercel validates this file against a strict schema and rejects
    // the whole deployment over an unknown key — while the previous
    // deployment carries on serving, so the site looks fine and simply
    // stops changing. JSON has nowhere to write a comment; the reasons
    // live in the files the rules are about.
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    const ALLOWED = {
      headers: ['source', 'headers', 'has', 'missing'],
      redirects: ['source', 'destination', 'permanent', 'statusCode', 'has', 'missing'],
      rewrites: ['source', 'destination', 'has', 'missing'],
    };
    for (const [section, allowed] of Object.entries(ALLOWED)) {
      for (const rule of vercel[section] || []) {
        for (const key of Object.keys(rule)) {
          expect(allowed, `vercel.json ${section}: "${key}" is not a key Vercel accepts`).toContain(key);
        }
      }
    }
  });

  it('lets a phone keep a vendored file rather than fetch it again', () => {
    // Safe only because the version is in the filename: a different
    // version is a different URL, which no cache has seen.
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    const rule = (vercel.headers || []).find(h => h.source.includes('/assets/vendor/'));
    expect(rule, 'no cache rule for the vendored libraries').toBeTruthy();
    const cache = rule.headers.find(h => h.key.toLowerCase() === 'cache-control');
    expect(cache.value).toMatch(/immutable/);
  });

  it('leaves the password-reset redirect on the current origin', () => {
    // Supabase only redirects to URLs on its own allow-list, and the one
    // that always matches is the origin the request came from. Pinning
    // this to the canonical site breaks a reset started anywhere else.
    const forgot = PAGES.find(p => p.rel === 'forgot-password.html').html;
    expect(forgot).toMatch(/redirectTo: location\.origin/);
  });
});

// Adding a column to a table means changing the <th> row and every
// colspan that spans it — the "no rows yet" message and the loading
// skeleton. Miss one and the table looks right until it is empty or
// still loading, which is exactly when nobody is looking closely.
describe('table colspans match a real column count', () => {
  const withTables = PAGES.filter(p => /<th>/.test(p.html));

  it('finds pages with tables', () => {
    expect(withTables.length).toBeGreaterThan(3);
  });

  it.each(withTables)('$rel', ({ rel, html }) => {
    // Every header row on the page, as a count of its columns.
    const counts = new Set(
      [...html.matchAll(/<tr>\s*(<th[\s\S]*?)<\/tr>/g)]
        .map(m => (m[1].match(/<th[\s>]/g) || []).length)
        .filter(Boolean));
    if (!counts.size) return;

    for (const m of html.matchAll(/\b(emptyRow|skeletonRows)\(\s*(\d+)/g)) {
      expect(counts.has(Number(m[2])),
        `${rel}: ${m[1]}(${m[2]}, …) spans ${m[2]} columns, but this page's tables have `
        + `${[...counts].sort((a, b) => a - b).join(' or ')}`).toBe(true);
    }
  });
});
