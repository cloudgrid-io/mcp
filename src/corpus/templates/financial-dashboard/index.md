# Template: financial-dashboard (persistent Next.js + Mongo P&L board)

A minimal but real, deployable financial dashboard: income/expense entries by
account, with live income / expense / net totals and a table (add + delete).
Data lives in the grid-shared MongoDB, so it survives refresh and is shared
across sessions — unlike a static page.

**Domain:** an entry is `{ account: string, amount: number, type: "income" |
"expense", at: Date }`. Totals = income, expense, net (income − expense),
derived from the entries.

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

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads entries, computes totals
services/web/app/entry-board.js         # client board: totals + table, POST/DELETE via the API
services/web/app/api/entries/route.js   # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: financial-dashboard
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
  "name": "financial-dashboard",
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
  return client.db();
}
```

## services/web/app/layout.js

```js
export const metadata = {
  title: "Financial Dashboard",
  description: "A persistent P&L / cashflow board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; margin-bottom: 1.5rem; }
  .card { border: 1px solid #8886; border-radius: .75rem; padding: 1rem; }
  .value { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #8883; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
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
import EntryBoard from "./entry-board.js";

export const dynamic = "force-dynamic";

async function listEntries() {
  const db = await getDb();
  const items = await db.collection("entries").find({}).sort({ at: -1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    account: e.account,
    amount: e.amount,
    type: e.type,
    at: e.at instanceof Date ? e.at.toISOString() : e.at,
  }));
}

export default async function Page() {
  const entries = await listEntries();
  return (
    <main>
      <h1>Financial Dashboard</h1>
      <p className="hint">P&amp;L / cashflow board — persisted in grid-shared Mongo.</p>
      <EntryBoard initialEntries={entries} />
    </main>
  );
}
```

## services/web/app/entry-board.js

```js
"use client";
import { useState } from "react";

const fmt = (n) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function totals(entries) {
  let income = 0, expense = 0;
  for (const e of entries) {
    if (e.type === "income") income += e.amount;
    else expense += e.amount;
  }
  return { income, expense, net: income - expense };
}

export default function EntryBoard({ initialEntries }) {
  const [entries, setEntries] = useState(initialEntries);
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("income");
  const t = totals(entries);

  async function add(e) {
    e.preventDefault();
    const acct = account.trim();
    const amt = Number(amount);
    if (!acct || !Number.isFinite(amt) || amt <= 0) return;
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: acct, amount: amt, type }),
    });
    if (res.ok) { setEntries((p) => [await res.json(), ...p]); setAccount(""); setAmount(""); }
  }

  async function remove(id) {
    const res = await fetch(`/api/entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEntries((p) => p.filter((e) => e.id !== id));
  }

  return (
    <div>
      <div className="totals">
        <div className="card"><div className="label">Income</div><div className="value income">{fmt(t.income)}</div></div>
        <div className="card"><div className="label">Expense</div><div className="value expense">{fmt(t.expense)}</div></div>
        <div className="card"><div className="label">Net</div><div className="value net">{fmt(t.net)}</div></div>
      </div>
      <form onSubmit={add} className="row">
        <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Account" />
        <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="income">Income</option>
          <option value="expense">Expense</option>
        </select>
        <button type="submit">Add</button>
      </form>
      <table>
        <thead><tr><th>Account</th><th>Type</th><th>Amount</th><th>Date</th><th></th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{e.account}</td>
              <td>{e.type}</td>
              <td className="num">{fmt(e.amount)}</td>
              <td>{new Date(e.at).toLocaleDateString()}</td>
              <td className="num"><button type="button" onClick={() => remove(e.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
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

function serialize(e) {
  return {
    id: e._id.toString(),
    account: e.account,
    amount: e.amount,
    type: e.type,
    at: e.at instanceof Date ? e.at.toISOString() : e.at,
  };
}

export async function GET() {
  const col = await entries();
  const items = await col.find({}).sort({ at: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const amount = Number(body.amount);
  const type = body.type === "expense" ? "expense" : "income";
  if (!account) return NextResponse.json({ error: "account is required" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  const col = await entries();
  const doc = { account, amount, type, at: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
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

- Rename the `entries` collection to your data.
- Change the document fields; add a category, currency, memo, or owner.
- Add more totals (per-account rollups, monthly buckets) or a chart.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
