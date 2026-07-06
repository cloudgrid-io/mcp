# Template: app-with-data (persistent Next.js + Mongo)

A minimal but real, deployable to-do app. Data lives in the grid-shared MongoDB,
so it survives refresh and is shared across sessions — unlike a static page.

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
`services/web/` — adapt the collection/fields to the user's app, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads todos from Mongo
services/web/app/todo-form.js           # client form: POST/DELETE via the API
services/web/app/api/todos/route.js     # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-app
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
  "name": "my-app",
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
// Cached MongoDB client for the App Router.
//
// The grid injects the connection string as the DATABASE_MONGODB_URL environment
// variable (plus the legacy MONGODB_URL alias) at runtime (after `grid plug`) and
// under `grid dev` locally. Read the canonical var first, fall back to the legacy
// alias. Never hardcode a connection string here and never commit a secret.
//
// The env var and client are resolved LAZILY (inside getDb), never at module top
// level — otherwise `next build` throws when it imports this module for route
// analysis, before the grid injects the var.
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it automatically — run " +
        "this app with `grid dev` locally, or deploy it with `grid plug` (the grid " +
        "injects the DB connection string at runtime). Do not set it by hand.",
    );
  }
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  const client = await clientPromise();
  // The default DB comes from the connection-string path segment the grid injects.
  return client.db();
}
```

## services/web/app/layout.js

```js
export const metadata = {
  title: "Todos",
  description: "A persistent todo app on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; }
  .row { display: flex; gap: .5rem; margin-bottom: 1rem; }
  input { flex: 1; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; justify-content: space-between; padding: .6rem 0; border-bottom: 1px solid #8883; }
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
import TodoForm from "./todo-form.js";

export const dynamic = "force-dynamic";

async function listTodos() {
  const db = await getDb();
  const items = await db.collection("todos").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((t) => ({ id: t._id.toString(), text: t.text, done: !!t.done }));
}

export default async function Page() {
  const todos = await listTodos();
  return (
    <main>
      <h1>Todos</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <TodoForm initialTodos={todos} />
    </main>
  );
}
```

## services/web/app/todo-form.js

```js
"use client";
import { useState } from "react";

export default function TodoForm({ initialTodos }) {
  const [todos, setTodos] = useState(initialTodos);
  const [text, setText] = useState("");

  async function add(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value }),
    });
    if (res.ok) { setTodos((p) => [await res.json(), ...p]); setText(""); }
  }

  async function remove(id) {
    const res = await fetch(`/api/todos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setTodos((p) => p.filter((t) => t.id !== id));
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a todo…" />
        <button type="submit">Add</button>
      </form>
      <ul>
        {todos.map((t) => (
          <li key={t.id}>
            <span>{t.text}</span>
            <button type="button" onClick={() => remove(t.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## services/web/app/api/todos/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function todos() {
  const db = await getDb();
  return db.collection("todos");
}

export async function GET() {
  const col = await todos();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map((t) => ({ id: t._id.toString(), text: t.text, done: !!t.done })));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  const col = await todos();
  const res = await col.insertOne({ text, done: false, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), text, done: false }, { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await todos();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `todos` collection to your data (`submissions`, `tasks`, `entries`).
- Change the document fields; add owners/timestamps/statuses.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
