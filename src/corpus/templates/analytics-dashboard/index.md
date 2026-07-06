# Template: analytics-dashboard (Next.js + Mongo usage analytics)

A minimal but real, deployable analytics dashboard. It stores **events**
(`{ type, value, at }`) in the grid-shared MongoDB, computes usage metrics
(total count, total value, distinct types, top type) plus a recent-events table,
and records new events via a POST. Data persists across refresh and is shared
across sessions — unlike a static page.

**Key rules (same proven shape as app-with-data):**

1. **Service code MUST live under `services/<name>/`, not the repo/template
   root.** `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
   The service named `web` → the CLI looks for `services/web/`. App files at the
   root fail with `Error: Service directory not found: …/services/web`.
2. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as the `DATABASE_MONGODB_URL` environment
   variable (plus the legacy `MONGODB_URL` alias) at dev-time and runtime; the
   app reads `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside
   `getDb`. A top-level read fails `next build` (the module is imported for route
   analysis before the grid injects the var). Never hardcode a connection string;
   never commit a secret.
3. **Declare the datastore with `needs: { database: true }`.** This is the
   canonical shape — the deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
   the deprecated v1 alias; don't author new yaml with it, and never set `needs:`
   and `requires:` together (the validator rejects the combination).
4. **Every API route + the page are `export const dynamic = "force-dynamic"`** —
   analytics is always live, never statically cached.

Write these files into the scaffolded app folder — the app code goes under
`services/web/` — adapt the collection/fields to the user's metrics, then
`grid dev` (local) / `grid plug` (deploy, async — poll to a live URL).

## The domain

An **event** is `{ type: string, value: number, at: Date }`. The dashboard shows
total count, total value (sum), distinct types, top type by value, and a recent
table; the form POSTs a new event.

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads events, computes counts/sums
services/web/app/event-form.js          # client form + recent-events table: POST/DELETE via the API
services/web/app/api/events/route.js    # GET (list) / POST (record) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: analytics-dashboard
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
// The env var and client are resolved LAZILY (inside getDb), never at module top
// level — otherwise `next build` throws when it imports this module for route
// analysis, before the grid injects the var.
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
  title: "Analytics Dashboard",
  description: "A usage analytics dashboard on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem; }
  .card { border: 1px solid #8884; border-radius: .6rem; padding: .9rem 1rem; }
  .card .k { font-size: .8rem; opacity: .7; } .card .v { font-size: 1.6rem; font-weight: 600; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  input, select, button { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #8883; }
  td.num { text-align: right; }
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
import EventForm from "./event-form.js";

export const dynamic = "force-dynamic";

async function loadEvents() {
  const db = await getDb();
  const items = await db.collection("events").find({}).sort({ at: -1 }).limit(50).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    type: e.type,
    value: typeof e.value === "number" ? e.value : 0,
    at: (e.at instanceof Date ? e.at : new Date(e.at)).toISOString(),
  }));
}

function summarize(events) {
  const totalValue = events.reduce((s, e) => s + e.value, 0);
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + e.value;
  const types = Object.keys(byType);
  return {
    totalCount: events.length,
    totalValue,
    distinctTypes: types.length,
    topType: types.sort((a, b) => byType[b] - byType[a])[0] || "—",
  };
}

export default async function Page() {
  const events = await loadEvents();
  const stats = summarize(events);
  return (
    <main>
      <h1>Analytics Dashboard</h1>
      <div className="cards">
        <div className="card"><div className="k">Events</div><div className="v">{stats.totalCount}</div></div>
        <div className="card"><div className="k">Total value</div><div className="v">{stats.totalValue}</div></div>
        <div className="card"><div className="k">Event types</div><div className="v">{stats.distinctTypes}</div></div>
        <div className="card"><div className="k">Top type</div><div className="v">{stats.topType}</div></div>
      </div>
      <EventForm initialEvents={events} />
    </main>
  );
}
```

## services/web/app/event-form.js

```js
"use client";
import { useMemo, useState } from "react";

export default function EventForm({ initialEvents }) {
  const [events, setEvents] = useState(initialEvents);
  const [type, setType] = useState("");
  const [value, setValue] = useState("1");

  async function record(e) {
    e.preventDefault();
    const t = type.trim();
    if (!t) return;
    const v = Number(value);
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: t, value: Number.isFinite(v) ? v : 1 }),
    });
    if (res.ok) { setEvents((p) => [await res.json(), ...p].slice(0, 50)); setType(""); setValue("1"); }
  }

  async function remove(id) {
    const res = await fetch(`/api/events?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEvents((p) => p.filter((e) => e.id !== id));
  }

  return (
    <div>
      <h2>Record an event</h2>
      <form onSubmit={record} className="row">
        <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Event type" />
        <input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" />
        <button type="submit">Record</button>
      </form>
      <h2>Recent events</h2>
      <table>
        <thead><tr><th>Type</th><th className="num">Value</th><th>At</th><th></th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{e.type}</td>
              <td className="num">{e.value}</td>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td className="num"><button type="button" onClick={() => remove(e.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
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

function serialize(e) {
  return {
    id: e._id.toString(),
    type: e.type,
    value: typeof e.value === "number" ? e.value : 0,
    at: (e.at instanceof Date ? e.at : new Date(e.at)).toISOString(),
  };
}

export async function GET() {
  const col = await events();
  const items = await col.find({}).sort({ at: -1 }).limit(50).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!type) return NextResponse.json({ error: "type is required" }, { status: 400 });
  const value = Number.isFinite(Number(body.value)) ? Number(body.value) : 1;
  const at = new Date();
  const col = await events();
  const res = await col.insertOne({ type, value, at });
  return NextResponse.json({ id: res.insertedId.toString(), type, value, at: at.toISOString() }, { status: 201 });
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

- Rename the `events` collection to your data.
- Change the document fields; add a `source`, `userId`, or tags.
- Add more aggregations (per-day buckets, per-type breakdown) in `summarize`.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
```
