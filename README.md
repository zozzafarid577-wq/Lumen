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

A project that already has an older `supabase-setup.sql` needs each
`supabase-migration-vN.sql` after it, in order. A fresh project does
not: the setup file already contains what they add. Every migration is
safe to run twice.

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

The **question bank has no student policy at all**: every row in it says
which option is correct, and tests are built by copying rows out of it.
Students reach it only through `POST /api/practice`, which sends question
and option text with `correct` removed and marks each answer server-side.
It serves a question only from a released unit of a course the caller is
enrolled on, and practice is never written to `test_attempts`.

Practice shows the answer once a student has had their go, so
`question_bank.practice_ok` decides per question whether they may meet it
there at all. It defaults to **true**, with one exception: questions filed
into the bank by saving a test arrive with `practice_ok = false`, because
those were written for a paper that may not have opened yet. A teacher
flips either way from the bank — "Hold back" / "Allow practice" on the
card, or the tick in the editor — and the flag is checked both when
questions are served and again when one is marked.

## What a student sees

Their dashboard opens on **their courses**, with the counts under them and
"what's waiting" and announcements as glances beside each other.

The work itself is on one page: **My courses**. It holds the units their
teacher has opened, and under each unit the lessons, the handouts on each
lesson, and the papers set on them. Units start collapsed — a term's worth
open at once is a page nobody can find anything in. Tests that belong to no
unit fall to "On the whole course" at the foot of the page.

**Lumi**, the character in the corner, is on every student page and is
mounted by `renderShell()`. What a student writes to it lands in
`support_requests` (migration v4) and shows on their teacher's dashboard
until the teacher marks it done. It is a row rather than an email on
purpose: a button that silently drops what a child typed is worse than no
button at all.

There is deliberately no separate Lessons or Tests tab — `/portal/lessons`
and `/portal/tests` redirect to `/portal/courses` (see `vercel.json`), so
old links still land somewhere. A test only appears under a unit if the
teacher chose one in the test builder; the Unit field there defaults to
"Whole course".

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
| `POST /api/practice`  | student                | Serve bank questions with the answers stripped, and mark one at a time |
| `POST /api/teachers`  | owner                  | Open, edit and delete spaces, set plans, raise and settle invoices |

\* with the matching permission.

No endpoint here is public. Every one of them authenticates the caller
first — which is the whole reason a teacher cannot open their own space.

Anything that needs the service-role key lives here: creating auth users,
setting passwords, deleting accounts, and writing rows that must land
together. Everything else goes straight from the browser through RLS.

## Where a question lives

A question carries four optional pointers — course, unit, lesson, and
section — and every one is `ON DELETE SET NULL`. That is the important
part: a question outlives the unit it was written for. It is still a
good question when next year's units are rebuilt, and cascading would
quietly empty a bank a teacher spent a term filling.

A lesson names its unit, so both APIs refuse a pair that disagrees: a
lesson without the unit it belongs to, or a lesson from a different
unit than the one chosen with it. Otherwise a Unit 1 test could be
filed under a Unit 4 lesson and appear in two places in the student
portal.

### Sections say what a paper asks

Course, unit and lesson say **where** in the course a test sits. They do
not say what it asks. A language teacher sets one paper on vocabulary
and another on grammar for the very same lesson, and needs to tell them
apart in a list of forty tests. `test_sections` is that label.

**Each teacher writes their own list** rather than choosing from ours.
Lumen is sold to whoever teaches: "Vocabulary" and "Grammar" are the
right two for an English teacher and meaningless to a chemistry one, and
a fixed set would be a migration every time a teacher wanted a section
we had not thought of. Nothing is seeded — a space that opens with
somebody else's words already in it reads as a bug. Teachers add their
own under **Settings → Test sections**.

Names are unique per teacher on `lower(name)`, so "grammar" typed in a
hurry is caught as the section that already exists. Removing a section
nulls the label on the rows that point at it; the dialog says how many
tests and questions that is, and that none of them are deleted.

When a test is saved, its section is filed alongside its unit — but the
two are decided **separately**. A question can easily know where it sits
and not what it asks, so filling both or neither would leave half the
bank unfilterable the day a teacher first adds sections.

### Questions go on the test and into the bank

A test used to be buildable only out of the bank, which put the work in
the wrong order: a teacher with fifty questions in a Word file had to
fill the bank first and build the test second. Questions can now be
pasted straight onto a test, and **saving a test files every question on
it into the bank**, tagged with that test's course, unit and lesson.

Two things make that safe to do on every save:

- **`question_bank.text_key`** — md5 of the question text, generated in
  Postgres. The server hashes what it is about to file and asks which
  hashes are already there, so a question picked onto three tests stays
  one row. It compares hashes rather than texts because these go out as
  a query string: 300 questions of 2000 characters is a URL no proxy
  will carry.
- **A question already filed keeps its unit.** The same question can be
  right for two lessons, and the last test to use it does not get to
  overwrite where it was filed. One that was never placed adopts the
  test's, which is what makes the unit filter worth anything on a bank
  filled before any of this existed.

Filing is deliberately not fatal. The test exists by that point, and
reporting it as failed would have the teacher build it a second time —
so the count comes back in the response and the page says what happened.

The paste box is parsed by `/api/questions` with `action: 'parse'`, the
same endpoint the bank's own importer previews with, so what is
understood in the two places cannot drift apart. It reads multiple
choice: options bulleted or lettered, the answer marked with a `*`,
a `(correct)`, or an `Answer: B` line.

## Changing a teacher's sign-in email

A teacher can fix most of their own details, but not the address they
sign in with — their settings page tells them to contact Lumen, and the
console's **Edit** on a space is where Lumen does it.

The address lives in three places that have to move together: `auth.users`
is what they sign in with, `profiles.email` is what every portal list
reads, and `teachers.contact_email` is what Lumen writes to. The sign-in
is changed first because it is the one write that can be refused for a
reason no check here can see; if the profile will not follow it, the
sign-in is put back and nothing else is touched.

The password is never reissued — a teacher whose address was corrected
should not be locked out of a space they were already using. The new
address is written to, which also proves it was typed correctly.

The slug can be changed here too. It is the one field with consequences
outside the database: it names the space in links and in the sign-in hint
its students are given, and it is the word typed back to delete a space.
Links anyone saved to the old one stop working, so the console warns
before saving.

## Deleting a teacher space

The one irreversible action in the product. It removes the teacher, every
account in their space, all their content and every result their students
recorded, and it is deliberately awkward: the console shows the counts
first and the slug has to be typed back before anything happens.

Two things it does that the database will not do on its own:

- **The auth users go first.** Deleting the `teachers` row cascades
  through the content, but never reaches `auth.users` — those rows hang
  off `profiles` the other way round. Left behind they would hold their
  email addresses forever, so nobody in that space could be re-created.
- **If an account will not delete, the space is left standing.** Removing
  accounts and removing the row are two steps; a run that dies between
  them must be safe to repeat, and it only is while the row is still
  there to find the rest by.

The deletion is logged with a null `teacher_id` on purpose — a log line
pointing at the deleted tenant would cascade away with it, and this is
the event most worth still having afterwards. Nothing in the console
displays those lines yet; read them from `activity_log` in SQL.

Pausing a space is the reversible alternative and is what the dialog
pushes you towards: it hides the portal from everyone in the space and
deletes nothing.

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
