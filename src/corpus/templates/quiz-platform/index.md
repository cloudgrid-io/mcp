# Template: quiz-platform (persistent Next.js + Mongo)

A minimal but real, deployable quiz / trivia app. Questions live in the
grid-shared MongoDB, so they survive refresh and are shared across sessions —
unlike a static page. Visitors take the quiz (pick one option per question,
submit for a score); an admin form adds new questions.

Domain: a `questions` collection of `{ prompt: string, options: string[],
answerIndex: number }` documents. `answerIndex` is the 0-based index of the
correct option; the score compares each chosen index against it.

**Key rules (all proven by a real end-to-end deploy):**

1. **Service code MUST live under `services/<name>/`, not the repo/template
   root.** `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
   The service named `web` → the CLI looks for `services/web/`. App files at the
   root fail with `Error: Service directory not found: …/services/web`.
2. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as the `DATABASE_MONGODB_URL` environment
   variable (plus the legacy `MONGODB_URL` alias) at dev-time and runtime; the
   app reads `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside
   `getDb`. A top-level `const uri = process.env.DATABASE_MONGODB_URL; if (!uri)
   throw` fails `next build` (the module is imported for route analysis before
   the grid injects the var). Never hardcode a connection string; never commit a
   secret.
3. **Declare the datastore with `needs: { database: true }`.** This is the
   canonical shape — the deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
   the deprecated v1 alias; don't author new yaml with it, and never set `needs:`
   and `requires:` together (the validator rejects the combination).

Write these files into the scaffolded app folder — the app code goes under
`services/web/` — adapt the collection/fields to the user's quiz, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                            # name + services.web (nextjs) + needs: { database: true }
services/web/package.json                 # next, react, react-dom, mongodb driver only
services/web/lib/db.js                    # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js                # root layout + inline CSS
services/web/app/page.js                  # server component: reads questions from Mongo
services/web/app/quiz.js                  # client: take-quiz UI (score) + admin add-question form
services/web/app/api/questions/route.js   # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: quiz-platform
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** this template's need is `database: true`. The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias), so an app reading either var works. `requires:` is the
> deprecated v1 alias — don't mix it with `needs:` (the validator rejects the
> combination). See the capability-map for the full injection table.

## services/web/package.json

```json
{
  "name": "quiz-platform",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "mongodb": "^6.12.0"
  }
}
```

## services/web/lib/db.js

```js
// Cached MongoDB client for the App Router. Read the connection string LAZILY
// (inside getDb), never at module top level — a top-level read fails next build.
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it automatically — run " +
        "this app with `grid dev` locally, or deploy it with `grid plug`. Do not set it by hand.",
    );
  }
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  const client = await clientPromise();
  return client.db();
}
```

## services/web/app/layout.js

```js
export const metadata = {
  title: "Quiz Platform",
  description: "A persistent quiz/trivia app on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; }
  .card { border: 1px solid #8883; border-radius: .75rem; padding: 1rem 1.15rem; margin-bottom: 1rem; }
  .options { list-style: none; padding: 0; margin: 0; display: grid; gap: .4rem; }
  .opt { width: 100%; text-align: left; padding: .5rem .7rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  .opt.selected { border-color: #4a90d9; background: #4a90d933; }
  .opt.correct { border-color: #3ba55d; background: #3ba55d33; }
  .opt.wrong { border-color: #d9534f; background: #d9534f33; }
  input { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  button.primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head><style dangerouslySetInnerHTML={{ __html: css }} /></head>
      <body>{children}</body>
    </html>
  );
}
```

## services/web/app/page.js

```js
import { getDb } from "../lib/db.js";
import Quiz from "./quiz.js";

export const dynamic = "force-dynamic";

async function listQuestions() {
  const db = await getDb();
  const items = await db.collection("questions").find({}).sort({ createdAt: -1 }).toArray();
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
      <p className="hint">Take the quiz, then add your own questions — persisted in grid-shared Mongo.</p>
      <Quiz initialQuestions={questions} />
    </main>
  );
}
```

## services/web/app/quiz.js

```js
"use client";
import { useState } from "react";

export default function Quiz({ initialQuestions }) {
  const [questions, setQuestions] = useState(initialQuestions);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [answerIndex, setAnswerIndex] = useState(0);

  const score = questions.reduce((n, q) => (answers[q.id] === q.answerIndex ? n + 1 : n), 0);

  async function addQuestion(e) {
    e.preventDefault();
    const cleanPrompt = prompt.trim();
    const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
    if (!cleanPrompt || cleanOptions.length < 2) return;
    const res = await fetch("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: cleanPrompt, options: cleanOptions, answerIndex: Math.min(answerIndex, cleanOptions.length - 1) }),
    });
    if (res.ok) { setQuestions((p) => [await res.json(), ...p]); setPrompt(""); setOptions(["", "", "", ""]); setAnswerIndex(0); setSubmitted(false); }
  }

  async function remove(id) {
    const res = await fetch(`/api/questions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setQuestions((p) => p.filter((q) => q.id !== id));
  }

  return (
    <div>
      <h2>Take the quiz</h2>
      <form onSubmit={(e) => { e.preventDefault(); setSubmitted(true); }}>
        {questions.map((q) => (
          <div className="card" key={q.id}>
            <p className="prompt">{q.prompt}</p>
            <ul className="options">
              {q.options.map((opt, i) => {
                let cls = "opt";
                if (submitted && i === q.answerIndex) cls += " correct";
                else if (submitted && answers[q.id] === i) cls += " wrong";
                else if (answers[q.id] === i) cls += " selected";
                return (
                  <li key={i}>
                    <button type="button" className={cls} disabled={submitted}
                      onClick={() => !submitted && setAnswers((p) => ({ ...p, [q.id]: i }))}>{opt}</button>
                  </li>
                );
              })}
            </ul>
            <button type="button" onClick={() => remove(q.id)}>Delete</button>
          </div>
        ))}
        {questions.length > 0 && !submitted && <button type="submit" className="primary">Submit quiz</button>}
      </form>
      {submitted && <p className="score">Score: {score} / {questions.length}</p>}

      <h2>Add a question</h2>
      <form onSubmit={addQuestion}>
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Question prompt…" />
        {options.map((opt, i) => (
          <div className="row" key={i}>
            <input value={opt} onChange={(e) => setOptions((p) => p.map((o, j) => (j === i ? e.target.value : o)))} placeholder={`Option ${i + 1}`} />
            <label><input type="radio" name="ans" checked={answerIndex === i} onChange={() => setAnswerIndex(i)} /> correct</label>
          </div>
        ))}
        <button type="submit" className="primary">Add question</button>
      </form>
    </div>
  );
}
```

## services/web/app/api/questions/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function questions() {
  const db = await getDb();
  return db.collection("questions");
}

const shape = (q) => ({
  id: q._id.toString(),
  prompt: q.prompt,
  options: Array.isArray(q.options) ? q.options : [],
  answerIndex: typeof q.answerIndex === "number" ? q.answerIndex : 0,
});

export async function GET() {
  const col = await questions();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const options = Array.isArray(body.options) ? body.options.map((o) => String(o).trim()).filter(Boolean) : [];
  let answerIndex = Number.isInteger(body.answerIndex) ? body.answerIndex : 0;
  if (!prompt || options.length < 2) return NextResponse.json({ error: "prompt and at least 2 options are required" }, { status: 400 });
  if (answerIndex < 0 || answerIndex >= options.length) answerIndex = 0;
  const col = await questions();
  const res = await col.insertOne({ prompt, options, answerIndex, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), prompt, options, answerIndex }, { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await questions();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `questions` collection to your data.
- Change the document fields; add categories, difficulty, explanations, an owner.
- Persist quiz attempts / build a leaderboard as a second collection.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
