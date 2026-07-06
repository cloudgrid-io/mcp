# Template: expense-tracker (persistent Next.js + Mongo)

A minimal but real, deployable expense tracker. Expenses live in the grid-shared
MongoDB, so they survive refresh and are shared across sessions — unlike a static
page. Each expense is `{ description, amount (number), category, date }`; the app
lists expenses, totals them by category, and supports add + delete.

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
services/web/app/page.js                # server component: reads expenses from Mongo
services/web/app/expense-form.js        # client form + table + totals by category
services/web/app/api/expenses/route.js  # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: expense-tracker
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
  "name": "expense-tracker",
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
  title: "Expense Tracker",
  description: "A persistent expense tracker on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  form.row { display: grid; grid-template-columns: 2fr 1fr 1.2fr 1.2fr auto; gap: .5rem; margin-bottom: 1rem; align-items: end; }
  label { display: flex; flex-direction: column; gap: .2rem; font-size: .75rem; opacity: .8; }
  input, select { padding: .5rem .6rem; border: 1px solid #8886; border-radius: .5rem; width: 100%; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #8883; }
  td.amount, th.amount { text-align: right; }
  .totals { list-style: none; padding: 0; margin: 0; }
  .totals li { display: flex; justify-content: space-between; padding: .4rem 0; border-bottom: 1px solid #8883; }
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
import ExpenseTracker from "./expense-form.js";

export const dynamic = "force-dynamic";

async function listExpenses() {
  const db = await getDb();
  const items = await db.collection("expenses").find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(), description: e.description, amount: e.amount, category: e.category, date: e.date,
  }));
}

export default async function Page() {
  const expenses = await listExpenses();
  return (
    <main>
      <h1>Expense Tracker</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <ExpenseTracker initialExpenses={expenses} />
    </main>
  );
}
```

## services/web/app/expense-form.js

```js
"use client";
import { useState, useMemo } from "react";

const CATEGORIES = ["Food", "Transport", "Housing", "Utilities", "Entertainment", "Health", "Other"];
const fmt = (n) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
const today = () => new Date().toISOString().slice(0, 10);

export default function ExpenseTracker({ initialExpenses }) {
  const [expenses, setExpenses] = useState(initialExpenses);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [date, setDate] = useState(today());

  const totals = useMemo(() => {
    const byCat = {}; let grand = 0;
    for (const e of expenses) { byCat[e.category] = (byCat[e.category] || 0) + e.amount; grand += e.amount; }
    return { rows: Object.entries(byCat).sort((a, b) => b[1] - a[1]), grand };
  }, [expenses]);

  async function add(e) {
    e.preventDefault();
    const desc = description.trim(); const amt = Number.parseFloat(amount);
    if (!desc || !Number.isFinite(amt)) return;
    const res = await fetch("/api/expenses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: desc, amount: amt, category, date }),
    });
    if (res.ok) { setExpenses((p) => [await res.json(), ...p]); setDescription(""); setAmount(""); }
  }

  async function remove(id) {
    const res = await fetch(`/api/expenses?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setExpenses((p) => p.filter((e) => e.id !== id));
  }

  return (
    <div>
      <form onSubmit={add} className="row">
        <label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Coffee, rent…" /></label>
        <label>Amount<input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></label>
        <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <button type="submit">Add</button>
      </form>
      <h2>Expenses</h2>
      <table>
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className="amount">Amount</th><th></th></tr></thead>
        <tbody>
          {expenses.map((e) => (
            <tr key={e.id}>
              <td>{e.date}</td><td>{e.description}</td><td>{e.category}</td><td className="amount">{fmt(e.amount)}</td>
              <td><button type="button" onClick={() => remove(e.id)}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Totals by category</h2>
      <ul className="totals">
        {totals.rows.map(([cat, sum]) => <li key={cat}><span>{cat}</span><span>{fmt(sum)}</span></li>)}
        {totals.rows.length > 0 && <li className="grand"><span>Total</span><span>{fmt(totals.grand)}</span></li>}
      </ul>
    </div>
  );
}
```

## services/web/app/api/expenses/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

const shape = (e) => ({ id: e._id.toString(), description: e.description, amount: e.amount, category: e.category, date: e.date });

async function expenses() {
  const db = await getDb();
  return db.collection("expenses");
}

export async function GET() {
  const col = await expenses();
  const items = await col.find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : Number.parseFloat(body.amount);
  const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : "Other";
  const date = typeof body.date === "string" && body.date ? body.date : new Date().toISOString().slice(0, 10);
  if (!description || !Number.isFinite(amount)) return NextResponse.json({ error: "description and a numeric amount are required" }, { status: 400 });
  const col = await expenses();
  const doc = { description, amount, category, date, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ ...doc, _id: res.insertedId }), { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await expenses();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `expenses` collection to your data if the domain differs.
- Change the document fields or the category list in `expense-form.js`.
- Add more routes/collections (budgets, recurring bills) as the app grows.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
```
