// Turning a block of typed multiple-choice questions into rows.
//
// Teachers arrive with questions already written — in Word, in a PDF, in
// a WhatsApp message — and retyping fifty of them into a form is how a
// question bank never gets filled. This accepts the shapes those
// questions actually come in rather than one shape of our choosing.
//
// A question is a line of text, then its options, then optionally an
// answer line and an explanation. Options may be numbered "A)" "A." "a-"
// or bulleted "-" / "*", and the correct one may be marked inline with a
// leading "*", a trailing "(correct)", or named on an "Answer: B" line.

const OPTION_RE   = /^\s*(?:\(?([A-Ha-h])[).:\-]|[-*•])\s+(.*\S)\s*$/;
const ANSWER_RE   = /^\s*(?:answer|ans|correct)\s*[:\-]\s*(.+?)\s*$/i;
const EXPLAIN_RE  = /^\s*(?:explanation|why|because)\s*[:\-]\s*(.+?)\s*$/i;
// "1." / "1)" / "Q1." in front of the question text is numbering, not part
// of the question.
const QNUM_RE     = /^\s*(?:q(?:uestion)?\s*)?\d+\s*[).:\-]\s*/i;
// A "*" that sits tight against what follows marks the correct answer —
// "*B) Mitochondrion" or "- *semi-conservative". A "*" with a space after
// it is just a bullet, so the two are told apart by that space alone.
const CORRECT_STAR = /^(\s*)\*(?=\S)/;
const TRAILING_OK = /\s*\((?:correct|right|true|answer)\)\s*$/i;

export function parseQuestionText(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');

  const questions = [];
  const problems = [];
  let current = null;

  const finish = () => {
    if (!current) return;
    const issue = validate(current);
    if (issue) problems.push(`${truncate(current.question_text)} — ${issue}`);
    else questions.push(toRow(current));
    current = null;
  };

  for (const line of lines) {
    const text = line.trimEnd();
    if (!text.trim()) continue;                     // blank lines separate nothing on their own

    const answer = ANSWER_RE.exec(text);
    if (answer && current) { applyAnswerLine(current, answer[1]); continue; }

    const explain = EXPLAIN_RE.exec(text);
    if (explain && current) { current.explanation = explain[1]; continue; }

    // The star can sit before the label ("*B) …") or after it ("- *…"),
    // so it is taken off the front of the line first and looked for again
    // inside the option's own text.
    let candidate = text;
    let starred = false;
    const star = CORRECT_STAR.exec(candidate);
    if (star) { starred = true; candidate = star[1] + candidate.slice(star[0].length); }

    const option = OPTION_RE.exec(candidate);
    if (option && current) {
      let body = option[2];
      let correct = starred;
      const inner = CORRECT_STAR.exec(body);
      if (inner) { correct = true; body = body.slice(inner[0].length); }
      if (TRAILING_OK.test(body)) { correct = true; body = body.replace(TRAILING_OK, ''); }
      current.options.push({ letter: (option[1] || '').toLowerCase(), text: body.trim(), correct });
      continue;
    }

    // Anything else starts a new question. An option-looking line with no
    // question above it lands here too, which is right: it has nothing to
    // belong to.
    finish();
    current = { question_text: text.replace(QNUM_RE, '').trim(), options: [], explanation: null };
  }
  finish();

  return { questions, problems };
}

// "Answer: B", "Answer: b, c", "Answer: 2" or the option's own text.
function applyAnswerLine(q, value) {
  const wanted = String(value).split(/[,/]|\band\b/i).map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const w of wanted) {
    const byLetter = q.options.find(o => o.letter && o.letter === w.replace(/[).:\-]$/, ''));
    if (byLetter) { byLetter.correct = true; continue; }

    const asNumber = parseInt(w, 10);
    if (Number.isInteger(asNumber) && q.options[asNumber - 1]) { q.options[asNumber - 1].correct = true; continue; }

    const byText = q.options.find(o => o.text.toLowerCase() === w);
    if (byText) byText.correct = true;
  }
}

function validate(q) {
  if (!q.question_text) return 'the question text is missing';
  if (q.options.length < 2) return 'fewer than two options';
  if (q.options.length > 8) return 'more than eight options';
  if (!q.options.some(o => o.correct)) return 'no correct answer is marked';
  return null;
}

function toRow(q) {
  return {
    question_text: normalizeQuestionText(q.question_text).slice(0, 2000),
    options: q.options.map(o => ({ text: o.text.slice(0, 600), correct: o.correct })),
    explanation: q.explanation ? q.explanation.slice(0, 2000) : null,
  };
}

// What makes two questions the same question.
//
// The bank identifies a row by md5 of its text, so anything that changes
// the text by one invisible character files a second copy of a question
// a teacher would read as identical. That is not hypothetical: these are
// pasted out of Word and PDFs, which are full of non-breaking spaces,
// and a batch re-pasted after a small edit arrives with different
// spacing throughout.
//
// The same normalising runs in Postgres — public.normalize_question_text()
// in supabase-migration-v12.sql, on a trigger — and that one is
// authoritative, because the bank page writes to the table directly
// without passing through here. The two must agree, so this deliberately
// does NOT use JavaScript's \s: it matches more characters than
// Postgres's does (U+2028, U+205F, U+FEFF and friends), and a class that
// means something different in each language is exactly how the stored
// text and the hash drift apart.
//
// Case is left alone on purpose. "What is a noun?" and "what is a noun?"
// are the same question to a person, but upper- and lower-casing is the
// one operation Postgres and JavaScript genuinely disagree about across
// locales, and a dedup that is wrong is worse than one that is narrow.
const SPACE_CHARS = /[ \t\n\r\f\v ]+/g;

export function normalizeQuestionText(text) {
  return String(text ?? '').replace(SPACE_CHARS, ' ').trim();
}

function truncate(text, n = 60) {
  const s = String(text || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : (s || '(no text)');
}
