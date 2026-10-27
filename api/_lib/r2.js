import { AwsClient } from 'aws4fetch';

// Lumen's files live on Cloudflare R2, in two buckets:
//
//   R2_BUCKET         private — lesson PDFs and worksheets. Nobody reads
//                     one without a link this server signs, and it signs
//                     only for someone the database lets see the lesson.
//   R2_PUBLIC_BUCKET  public  — question pictures and teacher logos, which
//                     every student of the space sees anyway. Served from
//                     R2_PUBLIC_URL (the bucket's r2.dev address, or a
//                     custom domain on it later).
//
// Every key starts with the teacher's id, so the first segment of a key
// says whose space it belongs to — the same boundary the Supabase bucket
// policies drew, and the check every signer below makes before signing.
//
// R2 speaks the S3 API; aws4fetch signs the requests.

const env = (name) => (process.env[name] || '').trim();

export function r2Ready() {
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BUCKET', 'R2_PUBLIC_URL']
    .filter(n => !env(n));
  return { ready: !missing.length, missing };
}

let client = null;
function aws() {
  const { ready, missing } = r2Ready();
  if (!ready) throw new Error(`Cloudflare R2 is not set up: ${missing.join(', ')} missing.`);
  if (!client) client = new AwsClient({
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });
  return client;
}

export const PRIVATE = () => env('R2_BUCKET');
export const PUBLIC = () => env('R2_PUBLIC_BUCKET');

// Keys are made by Lumen from safe characters only, but each segment is
// still encoded so a key can never turn into a different path.
const enc = (key) => String(key).split('/').map(encodeURIComponent).join('/');
const objectUrl = (bucket, key) => `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${bucket}/${enc(key)}`;

// Where a file in the public bucket is read from.
export function publicUrl(key) {
  return `${env('R2_PUBLIC_URL').replace(/\/$/, '')}/${enc(key)}`;
}

// A file name as a key segment: letters, digits, dot, dash, underscore.
export function safeName(name, fallback = 'file') {
  const s = String(name || '').normalize('NFKD').replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(-80);
  return s || fallback;
}

// A link the browser uses once, for a few minutes, to PUT or GET one file.
export async function signedUrl(bucket, key, { method = 'GET', seconds = 3600, download = null } = {}) {
  const url = new URL(objectUrl(bucket, key));
  url.searchParams.set('X-Amz-Expires', String(seconds));
  if (download) url.searchParams.set('response-content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download)}`);
  const signed = await aws().sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

export async function putObject(bucket, key, body, contentType) {
  const res = await aws().fetch(objectUrl(bucket, key), {
    method: 'PUT', body, headers: contentType ? { 'content-type': contentType } : {},
  });
  if (!res.ok) throw new Error(`R2 refused the upload (${res.status}).`);
}

// Copy inside R2 without the bytes passing through here.
export async function copyObject(fromBucket, fromKey, toBucket, toKey) {
  const res = await aws().fetch(objectUrl(toBucket, toKey), {
    method: 'PUT', headers: { 'x-amz-copy-source': `/${fromBucket}/${enc(fromKey)}` },
  });
  if (!res.ok) throw new Error(`R2 could not copy a file (${res.status}).`);
}

export async function deleteObject(bucket, key) {
  const res = await aws().fetch(objectUrl(bucket, key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`R2 could not delete a file (${res.status}).`);
}

export async function headObject(bucket, key) {
  const res = await aws().fetch(objectUrl(bucket, key), { method: 'HEAD' });
  return res.ok;
}
