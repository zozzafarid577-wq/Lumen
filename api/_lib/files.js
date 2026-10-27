import { createClient } from '@supabase/supabase-js';
import { admin } from './supabase.js';
import { HttpError, requireRoles, requirePerm, assertTenant, logActivity } from './auth.js';
import { PRIVATE, PUBLIC, signedUrl, publicUrl, safeName, putObject, deleteObject, r2Ready } from './r2.js';

// Files on Cloudflare R2, through /api/support (the plan allows twelve
// functions and all twelve are taken).
//
// A lesson file is stored on its material row as "r2:<key>". The browser
// never holds R2's keys: it asks here for a link that works for one PUT
// (an upload) or for an hour of reading, and this is where the rules are
// checked — staff upload only into their own space's folder, and a
// reader gets a link only to a material the database already lets them
// see (the row is read with THEIR session, so row-level security decides,
// exactly as it does for the lesson itself).
//
// Older files still sit in Supabase storage as "lumen-file:<path>" until
// moveFilesToR2() has run for their space.

export const R2_FILE = 'r2:';
export const SUPABASE_FILE = 'lumen-file:';
const LESSON_FILE_MAX_MB = 50;

function userClient(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: header } },
  });
}

function staffOf(profile, perm) {
  requireRoles(profile, ['teacher', 'assistant']);
  requirePerm(profile, perm);
  if (!profile.teacher_id) throw new HttpError(403, 'This account is not attached to a teacher.');
  return profile.teacher_id;
}

// A key is only ever acted on inside the caller's own folder.
function ownKey(key, teacherId) {
  const k = String(key || '');
  if (!k.startsWith(`${teacherId}/`) || k.includes('..') || k.includes('//')) {
    throw new HttpError(403, 'That file belongs to another space.');
  }
  return k;
}

function needR2() {
  const { ready, missing } = r2Ready();
  if (!ready) throw new HttpError(503, `File storage is not set up yet (${missing.join(', ')}).`);
}

// A link to upload one lesson file into the private bucket. Until R2's
// keys are in place the answer is `{ r2: false }`, and the page uploads
// to Supabase storage as it did before — so uploads never stop working
// while the switch is being made.
export async function lessonUploadLink(profile, body) {
  const teacherId = staffOf(profile, 'courses');
  if (!r2Ready().ready) return { r2: false };
  const lessonId = String(body.lesson_id || '');
  if (!lessonId) throw new HttpError(400, 'Which lesson?');
  await assertTenant('lessons', lessonId, teacherId);
  if (Number(body.size) > LESSON_FILE_MAX_MB * 1048576) throw new HttpError(400, `Files can be up to ${LESSON_FILE_MAX_MB} MB.`);
  const key = `${teacherId}/lessons/${lessonId}/${Date.now()}-${safeName(body.name)}`;
  return { r2: true, key, file_url: R2_FILE + key, url: await signedUrl(PRIVATE(), key, { method: 'PUT', seconds: 600 }) };
}

// A link to read one lesson file, for whoever may see its lesson.
export async function lessonViewLink(req, profile, body) {
  needR2();
  const id = String(body.material_id || '');
  if (!id) throw new HttpError(400, 'Which file?');
  const { data: m } = await userClient(req).from('lesson_materials')
    .select('id, title, file_url, teacher_id').eq('id', id).maybeSingle();
  if (!m || !String(m.file_url).startsWith(R2_FILE)) throw new HttpError(404, 'This file is not available.');
  const key = ownKey(m.file_url.slice(R2_FILE.length), m.teacher_id);
  const ext = (key.split('.').pop() || '').toLowerCase();
  const name = m.title + (ext && !m.title.toLowerCase().endsWith('.' + ext) ? '.' + ext : '');
  return {
    url: await signedUrl(PRIVATE(), key, { seconds: 3600 }),
    download: await signedUrl(PRIVATE(), key, { seconds: 3600, download: name }),
    ext,
  };
}

export async function deleteLessonFiles(profile, body) {
  needR2();
  const teacherId = staffOf(profile, 'courses');
  const keys = (Array.isArray(body.keys) ? body.keys : []).slice(0, 200).map(k => ownKey(k, teacherId));
  for (const k of keys) await deleteObject(PRIVATE(), k);
  return { deleted: keys.length };
}

// A link to upload a public picture: a logo, or a question's figure.
export async function publicUploadLink(profile, body) {
  if (!r2Ready().ready) return { r2: false };
  const purpose = body.purpose === 'branding' ? 'branding' : body.purpose === 'question' ? 'questions' : null;
  if (!purpose) throw new HttpError(400, 'What is the picture for?');
  if (!/^image\//.test(String(body.type || ''))) throw new HttpError(400, 'Only pictures can go here.');
  if (Number(body.size) > 10 * 1048576) throw new HttpError(400, 'Pictures can be up to 10 MB.');
  const teacherId = purpose === 'branding' ? (requireRoles(profile, ['teacher']), profile.teacher_id) : staffOf(profile, 'tests');
  const key = `${teacherId}/${purpose}/${Date.now()}-${safeName(body.name, 'picture')}`;
  return { r2: true, key, public_url: publicUrl(key), url: await signedUrl(PUBLIC(), key, { method: 'PUT', seconds: 600 }) };
}

// ── Moving a space's existing files onto R2 ───────────────────────
// Lesson files from Supabase storage, the logo, and question pictures
// that live on the site itself or in Supabase. Each is copied first and
// its row repointed after; the old copy is left where it was, so nothing
// is lost if a step fails — run it again and it carries on from there.

const SITE = () => {
  const u = (process.env.PUBLIC_URL || 'https://lumenlearn.site').trim().replace(/\/$/, '');
  return u.startsWith('http') ? u : 'https://' + u;
};
const supabaseHost = () => new URL(process.env.SUPABASE_URL).host;
const isOurOldPicture = (url) => {
  try {
    const u = new URL(url, SITE());
    return (u.host === new URL(SITE()).host && u.pathname.startsWith('/assets/questions/'))
      || (u.host === supabaseHost() && u.pathname.includes('/storage/v1/object/public/'));
  } catch (_) { return false; }
};

async function bytesOf(url) {
  const res = await fetch(new URL(url, SITE()));
  if (!res.ok) throw new Error(`Could not read ${url} (${res.status}).`);
  return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || undefined };
}

export async function moveFilesToR2(profile, body) {
  needR2();
  let teacherId;
  if (profile.role === 'owner') {
    teacherId = String(body.teacher_id || '');
    if (!teacherId) throw new HttpError(400, 'teacher_id is required.');
  } else {
    requireRoles(profile, ['teacher']);
    teacherId = profile.teacher_id;
  }
  const out = { lessonFiles: 0, pictures: 0, logo: 0, failed: [] };

  // Lesson files.
  const { data: mats } = await admin.from('lesson_materials').select('id, title, file_url')
    .eq('teacher_id', teacherId).like('file_url', `${SUPABASE_FILE}%`);
  for (const m of mats || []) {
    try {
      const path = m.file_url.slice(SUPABASE_FILE.length);
      const { data: blob, error } = await admin.storage.from('lesson-media').download(path);
      if (error || !blob) throw new Error(error?.message || 'not found');
      const key = ownKey(path, teacherId);
      await putObject(PRIVATE(), key, Buffer.from(await blob.arrayBuffer()), blob.type || undefined);
      await admin.from('lesson_materials').update({ file_url: R2_FILE + key }).eq('id', m.id);
      out.lessonFiles++;
    } catch (err) { out.failed.push(`${m.title}: ${err.message}`); }
  }

  // Question pictures. One picture is often on several questions (a
  // copied test shares them), so each address is moved once.
  const { data: qs } = await admin.from('test_questions').select('id, image_url')
    .eq('teacher_id', teacherId).not('image_url', 'is', null);
  const moved = new Map();
  for (const q of qs || []) {
    if (!isOurOldPicture(q.image_url)) continue;
    try {
      if (!moved.has(q.image_url)) {
        const { body: bytes, type } = await bytesOf(q.image_url);
        const name = safeName(new URL(q.image_url, SITE()).pathname.split('/').pop(), 'picture');
        const key = `${teacherId}/questions/${Date.now()}-${moved.size}-${name}`;
        await putObject(PUBLIC(), key, bytes, type);
        moved.set(q.image_url, publicUrl(key));
        out.pictures++;
      }
      await admin.from('test_questions').update({ image_url: moved.get(q.image_url) }).eq('id', q.id);
    } catch (err) { out.failed.push(`picture ${q.image_url}: ${err.message}`); }
  }

  // The logo.
  const { data: t } = await admin.from('teachers').select('branding').eq('id', teacherId).maybeSingle();
  const logo = t?.branding?.logo_url;
  if (logo && isOurOldPicture(logo)) {
    try {
      const { body: bytes, type } = await bytesOf(logo);
      const key = `${teacherId}/branding/${safeName(new URL(logo).pathname.split('/').pop(), 'logo')}`;
      await putObject(PUBLIC(), key, bytes, type);
      await admin.from('teachers').update({ branding: { ...t.branding, logo_url: publicUrl(key) } }).eq('id', teacherId);
      out.logo = 1;
    } catch (err) { out.failed.push(`logo: ${err.message}`); }
  }

  await logActivity(teacherId, profile, 'files_moved_to_r2',
    `${out.lessonFiles} lesson files, ${out.pictures} pictures, ${out.logo ? 'the logo' : 'no logo'}${out.failed.length ? ` · ${out.failed.length} failed` : ''}`);
  return out;
}

// What is still outside R2, so a teacher (or Lumen) can see the move is done.
export async function filesLeftOffR2(teacherId) {
  const [{ count: lessonFiles }, { data: qs }, { data: t }] = await Promise.all([
    admin.from('lesson_materials').select('id', { count: 'exact', head: true }).eq('teacher_id', teacherId).like('file_url', `${SUPABASE_FILE}%`),
    admin.from('test_questions').select('image_url').eq('teacher_id', teacherId).not('image_url', 'is', null),
    admin.from('teachers').select('branding').eq('id', teacherId).maybeSingle(),
  ]);
  return {
    lessonFiles: lessonFiles || 0,
    pictures: new Set((qs || []).map(q => q.image_url).filter(isOurOldPicture)).size,
    logo: t?.branding?.logo_url && isOurOldPicture(t.branding.logo_url) ? 1 : 0,
  };
}
