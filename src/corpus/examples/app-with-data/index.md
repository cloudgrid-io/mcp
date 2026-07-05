# Example: app-with-data — "Team Task Board"

A filled reference imitating the `app-with-data` template: a persistent team
task board. Same stack (Next.js App Router + the `mongodb` driver, grid-shared
Mongo via `process.env.DATABASE_MONGODB_URL`), slightly richer than the bare
todo template — tasks have an `assignee` and a `status` (todo / doing / done),
and the API supports updating status via PATCH.

Data persists in the grid-shared Mongo, so the whole team sees the same board
across sessions and refresh.

**Same three proven rules as the template:** (1) app code lives under
**`services/web/`** (the service name, NOT the repo root — `path:` is the URL
mount); (2) the DB connection string is read **lazily inside the `getDb`
getter**, never at module top level (a top-level read fails `next build`); (3)
the datastore is declared with the canonical **`needs: { database: true }`** —
the deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the
legacy `MONGODB_URL` alias). Don't use the deprecated `requires:` alias.

## cloudgrid.yaml

```yaml
# `needs: { database: true }` is canonical: the deployer provisions Mongo and
# injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). `requires:`
# is the deprecated v1 alias — don't mix the two (the validator rejects it).
name: team-task-board
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

## services/web/package.json

```json
{
  "name": "team-task-board",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
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
// Cached Mongo client. The grid injects DATABASE_MONGODB_URL (plus the legacy
// MONGODB_URL alias) at dev + runtime. Read the canonical var first, fall back to
// the legacy alias. Resolve it LAZILY inside the getter — a top-level read fails
// `next build`.
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it — run `grid dev` " +
        "locally or deploy with `grid plug`. Do not set it by hand.",
    );
  }
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  return (await clientPromise()).db();
}
```

## services/web/app/api/tasks/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const STATUSES = ["todo", "doing", "done"];

async function tasks() {
  return (await getDb()).collection("tasks");
}

// GET /api/tasks — list the board.
export async function GET() {
  const col = await tasks();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(
    items.map((t) => ({
      id: t._id.toString(),
      title: t.title,
      assignee: t.assignee || "",
      status: t.status || "todo",
    })),
  );
}

// POST /api/tasks — add a task. Body: { title, assignee }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const doc = {
    title,
    assignee: typeof body.assignee === "string" ? body.assignee.trim() : "",
    status: "todo",
    createdAt: new Date(),
  };
  const col = await tasks();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/tasks — move a task. Body: { id, status }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, status } = body;
  if (!id || !ObjectId.isValid(id) || !STATUSES.includes(status)) {
    return NextResponse.json({ error: "valid id and status required" }, { status: 400 });
  }
  const col = await tasks();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/tasks?id=<id>
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await tasks();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## services/web/app/page.js

```js
import { getDb } from "../lib/db.js";
import Board from "./board.js";

export const dynamic = "force-dynamic";

async function listTasks() {
  const items = await (await getDb())
    .collection("tasks")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((t) => ({
    id: t._id.toString(),
    title: t.title,
    assignee: t.assignee || "",
    status: t.status || "todo",
  }));
}

export default async function Page() {
  const tasks = await listTasks();
  return (
    <main>
      <h1>Team Task Board</h1>
      <p className="hint">Shared across the team — persisted in grid Mongo.</p>
      <Board initialTasks={tasks} />
    </main>
  );
}
```

## services/web/app/board.js

```js
"use client";
import { useState } from "react";

const COLUMNS = ["todo", "doing", "done"];
const LABELS = { todo: "To do", doing: "Doing", done: "Done" };

export default function Board({ initialTasks }) {
  const [tasks, setTasks] = useState(initialTasks);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, assignee }),
    });
    if (res.ok) { setTasks((p) => [await res.json(), ...p]); setTitle(""); setAssignee(""); }
  }

  async function move(id, status) {
    const res = await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (res.ok) setTasks((p) => p.map((t) => (t.id === id ? { ...t, status } : t)));
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title…" />
        <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Assignee" />
        <button type="submit">Add</button>
      </form>
      <div className="board">
        {COLUMNS.map((col) => (
          <section key={col}>
            <h2>{LABELS[col]}</h2>
            {tasks.filter((t) => t.status === col).map((t) => (
              <article key={t.id}>
                <strong>{t.title}</strong>
                {t.assignee && <em> · {t.assignee}</em>}
                <div className="moves">
                  {COLUMNS.filter((c) => c !== col).map((c) => (
                    <button key={c} onClick={() => move(t.id, c)}>→ {LABELS[c]}</button>
                  ))}
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
```

## Notes

- Deploy the same way as the template: `grid dev` locally, `grid plug` to deploy
  (async — poll status to a live URL). Re-plug the same entity to keep one URL.
- The only store this needs is Mongo (`needs: { database: true }` — the deployer
  provisions Mongo and injects `DATABASE_MONGODB_URL`, plus the legacy
  `MONGODB_URL` alias). Add `cache: true` to `needs:` only for
  caching/sessions/pubsub you actually use.
- All app code lives under `services/web/`; the connection is read lazily inside
  `getDb`, never at module top level.
