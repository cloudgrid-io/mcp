# Template: feature-request-board (persistent Next.js + Mongo voting board)

A minimal but real, deployable feature request / feedback board. Users add
requests, upvote them, and each carries a status (open / planned / done). Data
lives in the grid-shared MongoDB, so votes and requests survive refresh and are
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
   `getDb`. A top-level read that throws fails `next build` (the module is
   imported for route analysis before the grid injects the var). Never hardcode a
   connection string; never commit a secret.
3. **Declare the datastore with `needs: { database: true }`.** This is the
   canonical shape — the deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
   the deprecated v1 alias; don't author new yaml with it, and never set `needs:`
   and `requires:` together (the validator rejects the combination).

Write these files into the scaffolded app folder — the app code goes under
`services/web/` — adapt the collection/fields to the user's app, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## Domain

A `requests` collection: `{ title, description, votes: number, status: open|planned|done, createdAt }`.
List (votes desc) + upvote (atomic `$inc` via PATCH) + add (POST).

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads requests from Mongo
services/web/app/board.js               # client board: upvote (PATCH) / add (POST)
services/web/app/api/requests/route.js  # GET (list) / POST (add) / PATCH (upvote) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: feature-request-board
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
  "name": "feature-request-board",
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
// Cached MongoDB client for the App Router. The grid injects DATABASE_MONGODB_URL
// (plus the legacy MONGODB_URL alias). Resolved LAZILY inside getDb — never at
// module top level, or `next build` throws before the grid injects the var.
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
  title: "Feature Requests",
  description: "A persistent feature request board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  form.add { display: grid; gap: .5rem; margin: 0 0 2rem; }
  input, textarea { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; width: 100%; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; gap: .9rem; padding: .9rem 0; border-bottom: 1px solid #8883; }
  .vote { display: flex; flex-direction: column; align-items: center; min-width: 3rem; }
  .status { font-size: .78rem; text-transform: uppercase; padding: .1rem .5rem; border-radius: 1rem; border: 1px solid #8886; }
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
import Board from "./board.js";

export const dynamic = "force-dynamic";

async function listRequests() {
  const db = await getDb();
  const items = await db.collection("requests").find({}).sort({ votes: -1, createdAt: -1 }).toArray();
  return items.map((r) => ({
    id: r._id.toString(),
    title: r.title,
    description: r.description || "",
    votes: r.votes || 0,
    status: r.status || "open",
  }));
}

export default async function Page() {
  const requests = await listRequests();
  return (
    <main>
      <h1>Feature Requests</h1>
      <p className="hint">Upvote what matters, add your own — persisted in the grid-shared Mongo.</p>
      <Board initialRequests={requests} />
    </main>
  );
}
```

## services/web/app/board.js

```js
"use client";
import { useState } from "react";

const STATUSES = ["open", "planned", "done"];
const sortByVotes = (list) => [...list].sort((a, b) => b.votes - a.votes);

export default function Board({ initialRequests }) {
  const [requests, setRequests] = useState(initialRequests);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  async function add(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const res = await fetch("/api/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: t, description: description.trim() }),
    });
    if (res.ok) { setRequests((p) => sortByVotes([await res.json(), ...p])); setTitle(""); setDescription(""); }
  }

  async function upvote(id) {
    const res = await fetch(`/api/requests?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vote: 1 }),
    });
    if (res.ok) {
      const u = await res.json();
      setRequests((p) => sortByVotes(p.map((r) => (r.id === id ? { ...r, votes: u.votes } : r))));
    }
  }

  return (
    <div>
      <form onSubmit={add} className="add">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Feature title…" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe it (optional)…" />
        <button type="submit">Add request</button>
      </form>
      <ul>
        {requests.map((r) => (
          <li key={r.id}>
            <div className="vote">
              <button type="button" onClick={() => upvote(r.id)} aria-label="Upvote">▲</button>
              <span className="count">{r.votes}</span>
            </div>
            <div className="body">
              <span className="title">{r.title}</span>{" "}
              <span className={`status ${STATUSES.includes(r.status) ? r.status : "open"}`}>{r.status}</span>
              {r.description && <p className="desc">{r.description}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## services/web/app/api/requests/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const STATUSES = ["open", "planned", "done"];

async function requests() {
  const db = await getDb();
  return db.collection("requests");
}

const shape = (r) => ({
  id: r._id.toString(),
  title: r.title,
  description: r.description || "",
  votes: r.votes || 0,
  status: r.status || "open",
});

export async function GET() {
  const col = await requests();
  const items = await col.find({}).sort({ votes: -1, createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const status = STATUSES.includes(body.status) ? body.status : "open";
  const col = await requests();
  const doc = { title, description, votes: 0, status, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ ...doc, _id: res.insertedId }), { status: 201 });
}

export async function PATCH(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  const update = {};
  if (typeof body.vote === "number") update.$inc = { votes: body.vote };
  if (STATUSES.includes(body.status)) update.$set = { status: body.status };
  if (!update.$inc && !update.$set) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const col = await requests();
  const doc = await col.findOneAndUpdate({ _id: new ObjectId(id) }, update, { returnDocument: "after" });
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(shape(doc));
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await requests();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `requests` collection to your data (`ideas`, `feedback`, `roadmap`).
- Change the document fields; add tags/authors/comment counts.
- The route already supports PATCH `{ status }` — add a status control in the UI.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
