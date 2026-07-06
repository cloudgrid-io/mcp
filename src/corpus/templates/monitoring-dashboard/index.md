# Template: monitoring-dashboard (service health board, Next.js + Mongo)

A real, deployable monitoring dashboard backed by grid-shared MongoDB: a
current-status grid + recent-history table. A **check** is a health sample —
`{ service, status (up/degraded/down), latencyMs, at }`. POST checks; the board
derives the current status (latest check per service) and shows rolling history.
Data survives refresh and is shared across sessions — unlike a static page.

**Key rules (same proven shape as app-with-data):**

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
`services/web/` — adapt the collection/fields to the user's services, then
`grid dev` (local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads checks, derives status grid
services/web/app/check-form.js          # client form + status grid + history table
services/web/app/api/checks/route.js    # GET (list) / POST (record) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: monitoring-dashboard
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
  "name": "monitoring-dashboard",
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
        "this app with `grid dev` locally, or deploy it with `grid plug`.",
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
  title: "Monitoring Dashboard",
  description: "A service health board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .75rem; }
  .card { border: 1px solid #8884; border-radius: .6rem; padding: .8rem .9rem; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 1rem; font-size: .75rem; font-weight: 600; }
  .badge.up { background: #1f8f4922; color: #1f8f49; }
  .badge.degraded { background: #b9770022; color: #b97700; }
  .badge.down { background: #c0392b22; color: #c0392b; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid #8883; }
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
import CheckForm from "./check-form.js";

export const dynamic = "force-dynamic";

async function listChecks() {
  const db = await getDb();
  const items = await db.collection("checks").find({}).sort({ at: -1 }).limit(200).toArray();
  return items.map((c) => ({
    id: c._id.toString(),
    service: c.service,
    status: c.status,
    latencyMs: c.latencyMs,
    at: (c.at instanceof Date ? c.at : new Date(c.at)).toISOString(),
  }));
}

function currentStatus(checks) {
  const seen = new Map();
  for (const c of checks) if (!seen.has(c.service)) seen.set(c.service, c);
  return [...seen.values()].sort((a, b) => a.service.localeCompare(b.service));
}

export default async function Page() {
  const checks = await listChecks();
  return (
    <main>
      <h1>Monitoring Dashboard</h1>
      <CheckForm initialChecks={checks} initialServices={currentStatus(checks)} />
    </main>
  );
}
```

## services/web/app/check-form.js

```js
"use client";
import { useState } from "react";

const STATUSES = ["up", "degraded", "down"];

function computeServices(checks) {
  const seen = new Map();
  for (const c of checks) if (!seen.has(c.service)) seen.set(c.service, c);
  return [...seen.values()].sort((a, b) => a.service.localeCompare(b.service));
}

export default function CheckForm({ initialChecks, initialServices }) {
  const [checks, setChecks] = useState(initialChecks);
  const [services, setServices] = useState(initialServices);
  const [service, setService] = useState("");
  const [status, setStatus] = useState("up");
  const [latency, setLatency] = useState("");

  async function add(e) {
    e.preventDefault();
    const name = service.trim();
    if (!name) return;
    const res = await fetch("/api/checks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: name, status, latencyMs: latency === "" ? undefined : Number(latency) }),
    });
    if (res.ok) {
      const next = [await res.json(), ...checks];
      setChecks(next); setServices(computeServices(next)); setService(""); setLatency("");
    }
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <input value={service} onChange={(e) => setService(e.target.value)} placeholder="Service name…" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="number" min="0" value={latency} onChange={(e) => setLatency(e.target.value)} placeholder="Latency ms" />
        <button type="submit">Record check</button>
      </form>
      <h2>Current status</h2>
      <div className="grid">
        {services.map((s) => (
          <div className="card" key={s.service}>
            <div>{s.service}</div>
            <span className={`badge ${s.status}`}>{s.status}</span>
          </div>
        ))}
      </div>
      <h2>Recent history</h2>
      <table>
        <thead><tr><th>Service</th><th>Status</th><th>Latency</th><th>At</th></tr></thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id}>
              <td>{c.service}</td>
              <td><span className={`badge ${c.status}`}>{c.status}</span></td>
              <td>{typeof c.latencyMs === "number" ? `${c.latencyMs} ms` : "—"}</td>
              <td>{new Date(c.at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

## services/web/app/api/checks/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const STATUSES = ["up", "degraded", "down"];

async function checks() {
  const db = await getDb();
  return db.collection("checks");
}

function serialize(c) {
  return {
    id: c._id.toString(),
    service: c.service,
    status: c.status,
    latencyMs: c.latencyMs,
    at: (c.at instanceof Date ? c.at : new Date(c.at)).toISOString(),
  };
}

export async function GET() {
  const col = await checks();
  const items = await col.find({}).sort({ at: -1 }).limit(200).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const service = typeof body.service === "string" ? body.service.trim() : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!service) return NextResponse.json({ error: "service is required" }, { status: 400 });
  if (!STATUSES.includes(status)) {
    return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
  }
  let latencyMs;
  if (body.latencyMs !== undefined && body.latencyMs !== null && body.latencyMs !== "") {
    const n = Number(body.latencyMs);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "latencyMs must be a non-negative number" }, { status: 400 });
    }
    latencyMs = n;
  }
  const doc = { service, status, at: new Date() };
  if (latencyMs !== undefined) doc.latencyMs = latencyMs;
  const col = await checks();
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await checks();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `checks` collection (`pings`, `incidents`, `samples`).
- Change document fields; add `region`, `endpoint`, `httpStatus`.
- Add an uptime percentage or a sparkline from the history.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
