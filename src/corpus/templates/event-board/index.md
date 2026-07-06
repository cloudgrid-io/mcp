# Template: event-board (persistent Next.js + Mongo)

A community event board: an upcoming-events list sorted by date, with add and
delete. Data lives in the grid-shared MongoDB, so events survive refresh and are
shared across sessions — unlike a static page.

Domain: `events` with fields **title, date, location, description**. Listed
sorted by `date` ascending (soonest upcoming first).

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
services/web/app/page.js                # server component: reads events from Mongo, sorted by date
services/web/app/event-form.js          # client form + upcoming list: POST/DELETE via the API
services/web/app/api/events/route.js    # GET (list, by date) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: event-board
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
  "name": "event-board",
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
  title: "Event Board",
  description: "A community event board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  form { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 2rem; }
  form .full { grid-column: 1 / -1; }
  input, textarea { width: 100%; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .8rem 0; border-bottom: 1px solid #8883; }
  .event-head { display: flex; justify-content: space-between; }
  .event-meta { font-size: .85rem; opacity: .75; }
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
import EventBoard from "./event-form.js";

export const dynamic = "force-dynamic";

async function listEvents() {
  const db = await getDb();
  const items = await db.collection("events").find({}).sort({ date: 1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    title: e.title,
    date: e.date,
    location: e.location,
    description: e.description,
  }));
}

export default async function Page() {
  const events = await listEvents();
  return (
    <main>
      <h1>Event Board</h1>
      <p className="hint">Community events, sorted by date — persisted in grid-shared Mongo.</p>
      <EventBoard initialEvents={events} />
    </main>
  );
}
```

## services/web/app/event-form.js

```js
"use client";
import { useState } from "react";

const byDate = (a, b) => String(a.date).localeCompare(String(b.date));

export default function EventBoard({ initialEvents }) {
  const [events, setEvents] = useState(initialEvents);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");

  async function add(e) {
    e.preventDefault();
    if (!title.trim() || !date.trim()) return;
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, date, location, description }),
    });
    if (res.ok) {
      setEvents((p) => [...p, await res.json()].sort(byDate));
      setTitle(""); setDate(""); setLocation(""); setDescription("");
    }
  }

  async function remove(id) {
    const res = await fetch(`/api/events?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEvents((p) => p.filter((e) => e.id !== id));
  }

  return (
    <div>
      <form onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="full" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location" />
        <textarea className="full" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" />
        <button className="full" type="submit">Add event</button>
      </form>
      <ul>
        {events.map((e) => (
          <li key={e.id}>
            <div className="event-head">
              <span>{e.title}</span>
              <button type="button" onClick={() => remove(e.id)}>Delete</button>
            </div>
            <div className="event-meta">{e.date}{e.location ? ` · ${e.location}` : ""}</div>
            {e.description && <p>{e.description}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## services/web/app/api/events/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function events() {
  const db = await getDb();
  return db.collection("events");
}

const shape = (e) => ({
  id: e._id.toString(), title: e.title, date: e.date, location: e.location, description: e.description,
});

export async function GET() {
  const col = await events();
  const items = await col.find({}).sort({ date: 1 }).toArray();
  return NextResponse.json(items.map(shape));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!title || !date) return NextResponse.json({ error: "title and date are required" }, { status: 400 });
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const col = await events();
  const res = await col.insertOne({ title, date, location, description, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), title, date, location, description }, { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await events();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `events` collection to your data (`meetups`, `sessions`, `gigs`).
- Change the document fields; add host/RSVP/category/end-time.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
