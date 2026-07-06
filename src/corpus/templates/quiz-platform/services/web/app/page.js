// Home page: a server component reads the questions straight from Mongo, and a
// client component runs the quiz (compute a score) plus an admin form to add
// questions. Data persists across refresh and across users because it lives in
// the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import Quiz from "./quiz.js";

export const dynamic = "force-dynamic";

async function listQuestions() {
  const db = await getDb();
  const items = await db
    .collection("questions")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((q) => ({
    id: q._id.toString(),
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
    answerIndex: typeof q.answerIndex === "number" ? q.answerIndex : 0,
  }));
}

export default async function Page() {
  const questions = await listQuestions();
  return (
    <main>
      <h1>Quiz Platform</h1>
      <p className="hint">
        Take the quiz, then add your own questions. Persisted in the grid-shared
        Mongo — survives refresh and is shared across everyone.
      </p>
      <Quiz initialQuestions={questions} />
    </main>
  );
}
