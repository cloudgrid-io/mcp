# Template: api-dashboard (Next.js + Mongo API request monitor)

A minimal but real, deployable API usage dashboard. Every request is logged to
the grid-shared MongoDB, so the log and derived metrics survive refresh and are
shared across sessions — unlike a static page.

The domain is a `requests` collection with `{ endpoint, status (number),
ms (number), at }`. The page renders a **metrics header** (count, avg ms, error
rate), a **record form**, and a **recent-requests table** with per-row delete.

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
services/web/app/page.js                # server component: reads requests + renders dashboard
services/web/app/dashboard.js           # client: metrics header + record form + recent table
services/web/app/api/requests/route.js  # GET (list) / POST (record) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-api-dashboard
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
// Cached MongoDB client for the App Router. The grid injects the connection
// string as DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias) at dev-time
// and runtime. Resolve it LAZILY (inside getDb), never at module top level —
// otherwise `next build` throws when it imports this module for route analysis.
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
  title: "API Dashboard",
  description: "Monitor API requests on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 56rem; margin: 3rem auto; padding: 0 1.25rem; }
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; margin-bottom: 1.75rem; }
  .metric { border: 1px solid #8883; border-radius: .6rem; padding: .9rem 1rem; }
  .metric .label { font-size: .75rem; text-transform: uppercase; opacity: .6; }
  .metric .value { font-size: 1.6rem; font-weight: 600; margin-top: .2rem; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid #8883; white-space: nowrap; }
  .status-ok { color: #2a9d4a; } .status-err { color: #d1453b; }
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
import Dashboard from "./dashboard.js";

export const dynamic = "force-dynamic";

async function listRequests() {
  const db = await getDb();
  const items = await db.collection("requests").find({}).sort({ at: -1 }).limit(50).toArray();
  return items.map((r) => ({
    id: r._id.toString(), endpoint: r.endpoint, status: r.status, ms: r.ms,
    at: r.at instanceof Date ? r.at.toISOString() : r.at,
  }));
}

export default async function Page() {
  const requests = await listRequests();
  return (
    <main>
      <h1>API Dashboard</h1>
      <p className="hint">Live request log persisted in grid-shared Mongo — survives refresh.</p>
      <Dashboard initialRequests={requests} />
    </main>
  );
}
```

## services/web/app/dashboard.js

```js
"use client";
import { useState } from "react";

function computeMetrics(requests) {
  const count = requests.length;
  if (count === 0) return { count: 0, avgMs: 0, errorRate: 0 };
  const totalMs = requests.reduce((s, r) => s + (Number(r.ms) || 0), 0);
  const errors = requests.filter((r) => Number(r.status) >= 400).length;
  return { count, avgMs: Math.round(totalMs / count), errorRate: Math.round((errors / count) * 1000) / 10 };
}

export default function Dashboard({ initialRequests }) {
  const [requests, setRequests] = useState(initialRequests);
  const [endpoint, setEndpoint] = useState("");
  const [status, setStatus] = useState("200");
  const [ms, setMs] = useState("");
  const metrics = computeMetrics(requests);

  async function record(e) {
    e.preventDefault();
    const path = endpoint.trim();
    if (!path) return;
    const res = await fetch("/api/requests", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: path, status: Number(status), ms: Number(ms) || 0 }),
    });
    if (res.ok) { setRequests((p) => [await res.json(), ...p].slice(0, 50)); setEndpoint(""); setMs(""); }
  }

  async function remove(id) {
    const res = await fetch(`/api/requests?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setRequests((p) => p.filter((r) => r.id !== id));
  }

  return (
    <div>
      <div className="metrics">
        <div className="metric"><div className="label">Requests</div><div className="value">{metrics.count}</div></div>
        <div className="metric"><div className="label">Avg latency</div><div className="value">{metrics.avgMs} ms</div></div>
        <div className="metric"><div className="label">Error rate</div><div className="value">{metrics.errorRate}%</div></div>
      </div>
      <form onSubmit={record} className="row">
        <input className="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="/api/endpoint" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option>200</option><option>400</option><option>404</option><option>500</option>
        </select>
        <input type="number" min="0" value={ms} onChange={(e) => setMs(e.target.value)} placeholder="ms" />
        <button type="submit">Record</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Endpoint</th><th>Status</th><th>Latency</th><th>When</th><th></th></tr></thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{r.endpoint}</td>
                <td className={Number(r.status) >= 400 ? "status-err" : "status-ok"}>{r.status}</td>
                <td>{r.ms} ms</td>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td><button type="button" onClick={() => remove(r.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

async function requests() {
  const db = await getDb();
  return db.collection("requests");
}

function serialize(r) {
  return {
    id: r._id.toString(), endpoint: r.endpoint, status: r.status, ms: r.ms,
    at: r.at instanceof Date ? r.at.toISOString() : r.at,
  };
}

export async function GET() {
  const col = await requests();
  const items = await col.find({}).sort({ at: -1 }).limit(50).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  const status = Number.isFinite(Number(body.status)) ? Number(body.status) : 200;
  const ms = Number.isFinite(Number(body.ms)) ? Math.max(0, Number(body.ms)) : 0;
  const at = new Date();
  const col = await requests();
  const res = await col.insertOne({ endpoint, status, ms, at });
  return NextResponse.json({ id: res.insertedId.toString(), endpoint, status, ms, at: at.toISOString() }, { status: 201 });
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

- Rename the `requests` collection to your data (`events`, `calls`, `hits`).
- Change the document fields; add method/region/user/response size.
- Add filtering or time-window aggregation to the metrics.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
```
