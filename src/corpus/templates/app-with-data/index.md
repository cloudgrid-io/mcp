# Template: app-with-data (persistent Next.js + Mongo)

A minimal but real, deployable to-do app. Data lives in the grid-shared MongoDB,
so it survives refresh and is shared across sessions — unlike a static page.

**Key rule:** the grid injects the DB connection string as the `MONGODB_URL`
environment variable at dev-time and runtime. The app reads
`process.env.MONGODB_URL`. Never hardcode a connection string; never commit a
secret. Declare `requires: [mongodb]` in `cloudgrid.yaml` — that is what makes
the grid provision Mongo and inject the env var.

Write these files into the scaffolded app folder, adapt the collection/fields to
the user's app, then `grid dev` (local) / `grid plug` (deploy, async — poll to a
live URL).

## File tree

```
cloudgrid.yaml
package.json
lib/db.js
app/layout.js
app/page.js
app/todo-form.js
app/api/todos/route.js
```

## cloudgrid.yaml

```yaml
name: my-app
services:
  web:
    type: nextjs
    path: /
requires:
  - mongodb        # alias: db — grid provisions Mongo and injects MONGODB_URL
  # - redis: private   # OPTIONAL — add only if the app needs Redis (injects REDIS_URL)
```

## package.json

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

## lib/db.js

```js
// Cached MongoDB client. The grid injects MONGODB_URL at dev-time and runtime;
// never hardcode a connection string or commit a secret.
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URL;
if (!uri) {
  throw new Error(
    "MONGODB_URL is not set. The grid injects it automatically — run with " +
      "`grid dev` locally, or deploy with `grid plug` (injected at runtime). " +
      "Do not set it by hand.",
  );
}

let clientPromise = globalThis.__mongoClientPromise;
if (!clientPromise) {
  const client = new MongoClient(uri);
  clientPromise = client.connect();
  globalThis.__mongoClientPromise = clientPromise;
}

export async function getDb() {
  const client = await clientPromise;
  return client.db();
}

export { clientPromise };
```

## app/layout.js

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

## app/page.js

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

## app/todo-form.js

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

## app/api/todos/route.js

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
- Add `redis: private` to `requires` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
