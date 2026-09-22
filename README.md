# Lumen — Educate with Excellence

Educational dashboards and student management, on subscription, for teachers.

One platform hosts many teachers. Each teacher gets their own space — their
students, courses, lessons, question bank, tests, assignments and reports —
with nothing shared between them. Lumen sells that space as a managed
service: a one-off setup, then a monthly fee that depends on how much of
the day-to-day work Lumen carries and how many students the teacher has.

## What's in the box

| Path             | What it is                                                              |
| ---------------- | ----------------------------------------------------------------------- |
| `index.html`, `pricing.html`, `features.html`, `contact.html` | The public site |
| `login.html`, `forgot-password.html`, `reset-password.html` | Sign-in and password recovery |
| `teacher/`       | The teacher portal — the management system                              |
| `portal/`        | The student portal                                                      |
| `admin/`         | The Lumen console — teacher spaces, billing, leads                      |
| `api/`           | Vercel serverless functions (anything needing the service-role key)     |
| `api/_lib/`      | Dependency-free helpers shared by the functions (unit-tested)           |
| `css/site.css`   | The public site's design system                                         |
| `css/portal.css` | The design system shared by all three portals                           |
| `js/`            | `config.js` (your Supabase values), `ui.js`, `auth.js`, `shell.js`, `site.js` |
| `supabase-setup.sql` | The whole database: tables, row-level security, storage           |
| `tests/`         | Vitest suite over the API handlers, the shared libraries, and the pages |

There is no build step. The pages are static HTML that load Supabase from a
CDN; `api/` is the only thing that runs on a server.

## Setting it up

### 1. The database

Create a Supabase project, open the SQL editor, and run
`supabase-setup.sql` in full. It creates every table, the row-level
security policies that separate one teacher from another, the storage
buckets, and the starting price list.

### 2. The front end

Fill in `js/config.js` with your project's URL and **anon** key
(Supabase → Project Settings → API):

```js
window.LUMEN_CONFIG = {
  SUPABASE_URL: 'https://your-project.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ…',
  …
};
```

The anon key is meant to be public — it is in every page the browser
loads. What keeps one teacher's students out of another teacher's data is
row-level security, not the secrecy of that key. **The service-role key
must never appear in `js/`.**

### 3. The API

Set three environment variables wherever you deploy (Vercel → Settings →
Environment Variables):

| Variable                    | Where to find it                          |
| --------------------------- | ----------------------------------------- |
| `SUPABASE_URL`              | Project Settings → API                    |
| `SUPABASE_ANON_KEY`         | Project Settings → API                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API (keep it secret)   |

### 4. The first Lumen account

Row-level security has no back door, so the very first account has to be
made outside the app:

1. **Authentication → Users → Add user**, with your email and a password.
   Tick "Auto Confirm User".
2. Open `supabase-owner-setup.sql`, put that email at the top, and run it
   in the SQL editor. It sets both halves — the `role` claim the policies
   read out of the JWT, and the `profiles` row the portal reads — and
   prints them back so you can see they match.
3. Sign in at `/login.html`. You land in `/admin/`.

From there, "Open a space" creates a teacher, their sign-in and their
subscription in one go.

There is no self-serve signup: a teacher cannot create their own space.
Every space is opened by Lumen from the console, after the call they book
on `/contact.html`.

### A note on this being a public repo

`js/config.js` is served to every visitor, so its contents are public
whatever the repo's visibility — that is fine for the anon key, which is
designed for it, **provided `supabase-setup.sql` has actually been run**.
Without those policies the anon key reads everything. The service-role key
belongs only in the deployment's environment variables, never in `js/`,
and never in a commit.

## How the tenancy works

Every teacher is one row in `teachers`, and every piece of content carries
that teacher's id. Isolation is enforced by row-level security reading two
claims out of the signed-in user's JWT:

```
app_metadata.role       -- 'owner' | 'teacher' | 'assistant' | 'student'
app_metadata.teacher_id -- which space they belong to
```

Both are written by the server-side API, which holds the service-role key,
when the account is created. A signed-in user cannot change their own
tenant or promote themselves. Reading the claims from the token rather
than from `profiles` also keeps the policies free of the recursive profile
lookup that makes RLS on a profiles table so easy to get wrong.

The service-role client in `api/` bypasses RLS, so every handler there
gets its tenant from `tenantFor()` in `api/_lib/auth.js` and checks any row
it was handed with `assertTenant()`. Those two functions are the whole
boundary; the tests in `tests/api/auth-lib.test.js` exist to keep them
honest.

Two things are enforced in the database rather than only in the pages:

- A **unit that has not been released** — not marked done, or with a
  future `open_at` — cannot have its lessons or materials read at all.
- A **test that has not opened** cannot have its questions read.

So the lock icons in the student portal are labels on a rule the database
is already applying, not the rule itself.

## Roles

| Role        | Signs in at | Can do                                                      |
| ----------- | ----------- | ----------------------------------------------------------- |
| `owner`     | `/admin/`   | Lumen staff: open spaces, set plans, raise invoices, read leads |
| `teacher`   | `/teacher/` | Everything inside their own space                            |
| `assistant` | `/teacher/` | Only the parts of their teacher's space they were given      |
| `student`   | `/portal/`  | Their own courses, tests, assignments and results            |

An assistant's permissions live in `profiles.staff_perms`. Hiding a nav
link is presentation — the page's own `requireAuth(…, { perm })` and the
API's `requirePerm()` are what actually stop them.

## Plans and limits

The price list lives in the `plans` table and the marketing site reads it
live, so changing a price is a database edit rather than an HTML one. The
service sheet quotes two things and both are in there: the **packages**
(what Lumen does for you) and the **student tiers** (what it costs at each
class size). `plans.listing` says which a row is.

A teacher's agreed limit and fee are **copied onto their subscription**
rather than read through `plans`, so re-pricing the catalogue never
silently changes what an existing teacher agreed to. The limit is checked
server-side in `api/_lib/subscription.js` before a student is created *or
reactivated* — the browser is where a teacher can least be expected to be
honest with themselves about how many students they have.

A late invoice pauses **new** accounts. It never cuts off students who
already have one: the teacher's payment is not the class's problem.

## The API

| Endpoint              | Who may call it        | What it does                                   |
| --------------------- | ---------------------- | ---------------------------------------------- |
| `POST /api/students`  | teacher, assistant*    | Create, reset password, pause, delete          |
| `POST /api/staff`     | teacher                | Add, re-permission, suspend, remove assistants |
| `POST /api/save-test` | teacher, assistant*    | Write a test and replace its questions in one call |
| `POST /api/questions` | teacher, assistant*    | Parse and import a pasted batch of questions   |
| `POST /api/teachers`  | owner                  | Open spaces, set plans, raise and settle invoices |

\* with the matching permission.

No endpoint here is public. Every one of them authenticates the caller
first — which is the whole reason a teacher cannot open their own space.

Anything that needs the service-role key lives here: creating auth users,
setting passwords, deleting accounts, and writing rows that must land
together. Everything else goes straight from the browser through RLS.

## Tests

```bash
npm install
npm test          # vitest run
npm run test:watch
```

The suite covers every `api/` handler (auth and role checks, tenant
boundaries, validation, and the rollback paths) against an in-memory
Supabase stand-in — no network, no real database — plus the shared
libraries, plus static checks over every page: inline JavaScript that
parses, links that go somewhere, script tags in a working order, no
hard-coded keys, and every guarded page actually guarding itself.

CI runs it on every push and pull request (`.github/workflows/ci.yml`).

## Deploying

Vercel serves the static files and runs `api/` with no configuration
beyond `vercel.json` and the three environment variables above. Any host
that serves static files and Node functions will do the same.
