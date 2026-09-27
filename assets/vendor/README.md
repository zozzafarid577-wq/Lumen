# Vendored libraries

Third-party code this site serves itself instead of loading from
somebody else's CDN.

## Why

A CDN costs a DNS lookup, a TLS handshake and a connection to a host
the browser has never spoken to — before a single byte of the library
arrives. On a phone on mobile data that is most of a second, and it
happens before the sign-in button works. Served from here it shares
the connection the page already has.

The old tag also pinned nothing:

    https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js

`@2` is "whatever the latest 2.x is today". A release with a bug in it
became this site's problem the moment it was published, with no commit
to point at. The filename here carries the exact version instead.

(That URL also served a file the package does not contain: jsdelivr
generated `supabase.min.js` on the fly, and unpkg answers 404 for it.
What is here is the real published artifact.)

## What is here

| File | Package | Version |
| --- | --- | --- |
| `supabase-2.117.0.js` | `@supabase/supabase-js` | 2.117.0 |

Taken from `node_modules`, which npm installed and integrity-checked
against `package-lock.json`, and verified byte-for-byte against the
copy jsdelivr serves.

## Upgrading

1. `npm install @supabase/supabase-js@<new version>`
2. `cp node_modules/@supabase/supabase-js/dist/umd/supabase.js assets/vendor/supabase-<new version>.js`
3. Point every page at the new filename:
   `grep -rl 'supabase-2.117.0.js' --include='*.html' . | xargs sed -i '' 's/supabase-2.117.0.js/supabase-<new>.js/g'`
4. Delete the old file.
5. `npm test` — a check fails if any page still loads this from a CDN,
   or points at a vendored file that is not here.

The new filename is the cache-bust: `vercel.json` tells browsers to
keep anything under `/assets/vendor/` for a year, which is only safe
because the version is in the name.
