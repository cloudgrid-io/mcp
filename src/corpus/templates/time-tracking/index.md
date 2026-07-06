# Template: time-tracking (persistent Next.js + Mongo)

A minimal but real, deployable time tracker / timesheet app. You log entries
(task, project, minutes, date); the app lists them and computes total time per
project. Data lives in the grid-shared MongoDB, so it survives refresh and is
shared across sessions — unlike a static page.

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

## Domain

An `entries` collection of `{ task, project, minutes:number, date }`: add an
entry, list entries newest-first, show totals per project, delete by id.

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads entries from Mongo
services/web/app/entry-form.js          # client form + per-project totals: POST/DELETE via the API
services/web/app/api/entries/route.js   # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: time-tracking
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
  "name": "time-tracking",
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
// Cached MongoDB client for the App Router. The grid injects the connection
// string as DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias) at runtime
// and under `grid dev`. Resolve the var + client LAZILY inside getDb, never at
// module top level — a top-level read fails `next build` route analysis.
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
  title: "Time Tracking",
  description: "A persistent time tracker on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h2 { margin: 2rem 0 .5rem; font-size: 1.1rem; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  input { flex: 1; min-width: 7rem; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  input[type="number"] { flex: 0 0 6rem; }
  input[type="date"] { flex: 0 0 9rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; justify-content: space-between; padding: .6rem 0; border-bottom: 1px solid #8883; }
  .meta { opacity: .7; font-size: .85rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #8883; }
  td.num, th.num { text-align: right; }
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
import EntryForm from "./entry-form.js";

export const dynamic = "force-dynamic";

async function listEntries() {
  const db = await getDb();
  const items = await db.collection("entries").find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(), task: e.task, project: e.project, minutes: e.minutes, date: e.date,
  }));
}

export default async function Page() {
  const entries = await listEntries();
  return (
    <main>
      <h1>Time Tracking</h1>
      <p className="hint">Log billable hours by project — persisted in the grid-shared Mongo.</p>
      <EntryForm initialEntries={entries} />
    </main>
  );
}
```

## services/web/app/entry-form.js

```js
"use client";
import { useState } from "react";

function totalsByProject(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.project, (map.get(e.project) || 0) + e.minutes);
  return [...map.entries()].map(([project, minutes]) => ({ project, minutes })).sort((a, b) => b.minutes - a.minutes);
}
function fmt(m) { const h = Math.floor(m / 60), r = m % 60; return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`; }

export default function EntryForm({ initialEntries }) {
  const [entries, setEntries] = useState(initialEntries);
  const [task, setTask] = useState("");
  const [project, setProject] = useState("");
  const [minutes, setMinutes] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  async function add(e) {
    e.preventDefault();
    const mins = parseInt(minutes, 10);
    if (!task.trim() || !project.trim() || !Number.isFinite(mins) || mins <= 0) return;
    const res = await fetch("/api/entries", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: task.trim(), project: project.trim(), minutes: mins, date }),
    });
    if (res.ok) { setEntries((p) => [await res.json(), ...p]); setTask(""); setMinutes(""); }
  }
  async function remove(id) {
    const res = await fetch(`/api/entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEntries((p) => p.filter((e) => e.id !== id));
  }

  const totals = totalsByProject(entries);
  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task" />
        <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Project" />
        <input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button type="submit">Log</button>
      </form>
      <h2>Totals per project</h2>
      <table><tbody>
        {totals.map((t) => (<tr key={t.project}><td>{t.project}</td><td className="num">{fmt(t.minutes)}</td></tr>))}
      </tbody></table>
      <h2>Entries</h2>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            <span><strong>{e.task}</strong> <span className="meta">{e.project} · {fmt(e.minutes)} · {e.date}</span></span>
            <button type="button" onClick={() => remove(e.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## services/web/app/api/entries/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function entries() {
  const db = await getDb();
  return db.collection("entries");
}

export async function GET() {
  const col = await entries();
  const items = await col.find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return NextResponse.json(items.map((e) => ({
    id: e._id.toString(), task: e.task, project: e.project, minutes: e.minutes, date: e.date,
  })));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const minutes = Number.isFinite(body.minutes) ? Math.trunc(body.minutes) : NaN;
  const date = typeof body.date === "string" && body.date.trim() ? body.date.trim() : new Date().toISOString().slice(0, 10);
  if (!task || !project || !Number.isFinite(minutes) || minutes <= 0) {
    return NextResponse.json({ error: "task, project and a positive minutes value are required" }, { status: 400 });
  }
  const col = await entries();
  const res = await col.insertOne({ task, project, minutes, date, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), task, project, minutes, date }, { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await entries();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `entries` collection to your data (`timesheets`, `sessions`).
- Change the document fields; add a rate, a user, or a billable flag.
- Add date-range/project filtering or a weekly rollup.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
