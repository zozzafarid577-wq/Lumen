import { admin } from './_lib/supabase.js';
import { handler, HttpError, authenticate, requireRoles, requirePerm, tenantFor, assertTenant, logActivity } from './_lib/auth.js';
import { parseQuestionText } from './_lib/questions.js';
import { cleanText } from './_lib/util.js';

// Bulk import into the question bank.
//
// Ordinary bank edits go straight from the browser through row-level
// security. This endpoint exists for the one thing the browser should not
// do alone: reading a teacher's pasted text and deciding what it means.
// Parsing it in one tested place means the preview a teacher approves and
// the rows that get saved come from the same code.
export default handler(async (req, res) => {
  const { profile } = await authenticate(req);
  requireRoles(profile, ['teacher', 'assistant', 'owner']);
  requirePerm(profile, 'questions');

  const body = req.body || {};
  const teacherId = tenantFor(profile, body.teacher_id);
  const text = String(body.text || '');

  if (!text.trim()) throw new HttpError(400, 'Paste some questions first.');
  if (text.length > 200000) throw new HttpError(400, 'That is too much text for one import. Try it in a few batches.');

  const { questions, problems } = parseQuestionText(text);

  // A preview, so a teacher sees what was understood before anything is
  // written. Nothing is saved on this path.
  if (body.action === 'parse') {
    return res.status(200).json({ questions, problems });
  }

  if (!questions.length) {
    throw new HttpError(400, problems.length
      ? 'None of those questions could be read. ' + problems[0]
      : 'No questions could be found in that text.');
  }

  if (body.course_id) await assertTenant('courses', body.course_id, teacherId);

  const topic = cleanText(body.topic, { max: 120 });
  const difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium';

  const { error } = await admin.from('question_bank').insert(
    questions.map(q => ({
      teacher_id: teacherId,
      course_id: body.course_id || null,
      topic,
      question_text: q.question_text,
      options: q.options,
      explanation: q.explanation,
      difficulty,
      is_published: body.is_published !== false,
    }))
  );
  if (error) throw new HttpError(500, 'Those questions could not be saved. Please try again.');

  await logActivity(teacherId, profile, 'questions_imported',
    `${questions.length} question${questions.length === 1 ? '' : 's'}${topic ? ' · ' + topic : ''}`);

  // The problems are returned even on success: a teacher who pasted 50
  // and got 47 needs to know which three were dropped, not just the count.
  return res.status(200).json({ imported: questions.length, problems });
});
