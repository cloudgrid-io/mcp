# Example: kanban — "Workflow Board"

A filled reference imitating the `kanban` template: a persistent trello-style
board. Same stack (Next.js App Router + the `mongodb` driver, grid-shared Mongo
via `process.env.DATABASE_MONGODB_URL`). Cards have a `title`, a `column` (todo /
doing / done) and an `order`; you add a card to the first column, move it between
columns, and delete it.

Data persists in the grid-shared Mongo, so the whole team sees the same board
across sessions and refresh.

**Same three proven rules as the template:** (1) app code lives under
**`services/web/`** (the service name, NOT the repo root — `path:` is the URL
mount); (2) the DB connection string is read **lazily inside the `getDb`
getter**, never at module top level (a top-level read fails `next build`); (3)
the datastore is declared with the canonical **`needs: { database: true }`** —
the deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
`MONGODB_URL` alias). Don't use the deprecated `requires:` alias.

## cloudgrid.yaml

```yaml
# `needs: { database: true }` is canonical: the deployer provisions Mongo and
# injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). `requires:`
# is the deprecated v1 alias — don't mix the two (the validator rejects it).
name: workflow-board
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
  "name": "workflow-board",
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

## services/web/app/api/cards/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const COLUMNS = ["todo", "doing", "done"];

async function cards() {
  return (await getDb()).collection("cards");
}

function shape(c) {
  return {
    id: c._id.toString(),
    title: c.title || "",
    column: COLUMNS.includes(c.column) ? c.column : "todo",
    order: typeof c.order === "number" ? c.order : 0,
  };
}

// GET /api/cards — list the board, ordered.
export async function GET() {
  const col = await cards();
  const items = await col.find({}).sort({ order: 1, createdAt: 1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/cards — add a card to the first column. Body: { title }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const doc = { title, column: "todo", order: Date.now(), createdAt: new Date() };
  const col = await cards();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/cards — move a card to another column. Body: { id, column }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, column } = body;
  if (!id || !ObjectId.isValid(id) || !COLUMNS.includes(column)) {
    return NextResponse.json({ error: "valid id and column required" }, { status: 400 });
  }
  const col = await cards();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { column } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/cards?id=<id>
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await cards();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## services/web/app/page.js

```js
import { getDb } from "../lib/db.js";
import Board from "./board.js";

export const dynamic = "force-dynamic";

const COLUMNS = ["todo", "doing", "done"];

async function listCards() {
  const items = await (await getDb())
    .collection("cards")
    .find({})
    .sort({ order: 1, createdAt: 1 })
    .toArray();
  return items.map((c) => ({
    id: c._id.toString(),
    title: c.title || "",
    column: COLUMNS.includes(c.column) ? c.column : "todo",
    order: typeof c.order === "number" ? c.order : 0,
  }));
}

export default async function Page() {
  const cards = await listCards();
  return (
    <main>
      <h1>Workflow Board</h1>
      <p className="hint">Shared across the team — persisted in grid Mongo.</p>
      <Board initialCards={cards} />
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

export default function Board({ initialCards }) {
  const [cards, setCards] = useState(initialCards);
  const [title, setTitle] = useState("");

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    const res = await fetch("/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (res.ok) { setCards((p) => [...p, await res.json()]); setTitle(""); }
  }

  async function move(id, column) {
    const res = await fetch("/api/cards", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, column }),
    });
    if (res.ok) setCards((p) => p.map((c) => (c.id === id ? { ...c, column } : c)));
  }

  async function remove(id) {
    const res = await fetch(`/api/cards?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setCards((p) => p.filter((c) => c.id !== id));
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a card…" />
        <button type="submit">Add</button>
      </form>
      <div className="board">
        {COLUMNS.map((column) => (
          <section key={column}>
            <h2>{LABELS[column]}</h2>
            {cards.filter((c) => c.column === column).map((c) => (
              <article key={c.id} className="card">
                <span className="title">{c.title}</span>
                <div className="moves">
                  {COLUMNS.filter((o) => o !== column).map((o) => (
                    <button key={o} type="button" onClick={() => move(c.id, o)}>→ {LABELS[o]}</button>
                  ))}
                  <button type="button" onClick={() => remove(c.id)}>Delete</button>
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
- The only store this needs is Mongo (`needs: { database: true }`). Add
  `cache: true` to `needs:` only for caching/sessions you actually use.
- All app code lives under `services/web/`; the connection is read lazily inside
  `getDb`, never at module top level.
