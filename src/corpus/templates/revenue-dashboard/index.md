# Template: revenue-dashboard (persistent Next.js + Mongo)

A minimal but real, deployable revenue/sales dashboard. Sales live in the
grid-shared MongoDB, so they survive refresh and are shared across sessions —
unlike a static page. Renders a **total revenue** figure, a **per-product
breakdown**, a **recent sales table**, and an **add-sale** form. Each sale is a
document in a `sales` collection: `{ product: string, amount: number, at: Date }`.

**Key rules (all proven by a real end-to-end deploy of the same shape):**

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
services/web/app/page.js                # server component: total + per-product breakdown + recent table
services/web/app/sale-form.js           # client form: POST a sale, refresh the server component
services/web/app/api/sales/route.js     # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: revenue-dashboard
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
  "name": "revenue-dashboard",
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
// and runtime. The env var and client are resolved LAZILY (inside getDb), never
// at module top level — otherwise `next build` throws when it imports this module
// for route analysis, before the grid injects the var.
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
  title: "Revenue Dashboard",
  description: "A persistent revenue/sales dashboard on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 48rem; margin: 3rem auto; padding: 0 1.25rem; }
  .total { font-size: 2.5rem; font-weight: 700; margin: .25rem 0 0; }
  .total-label { margin: 0; opacity: .6; font-size: .85rem; text-transform: uppercase; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .75rem; }
  .card { border: 1px solid #8883; border-radius: .6rem; padding: .75rem .9rem; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  input { flex: 1; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #8883; }
  td.amt, th.amt { text-align: right; font-variant-numeric: tabular-nums; }
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
import SaleForm from "./sale-form.js";

export const dynamic = "force-dynamic";

async function listSales() {
  const db = await getDb();
  const items = await db.collection("sales").find({}).sort({ at: -1 }).toArray();
  return items.map((s) => ({
    id: s._id.toString(),
    product: s.product,
    amount: typeof s.amount === "number" ? s.amount : 0,
    at: (s.at instanceof Date ? s.at : new Date(s.at)).toISOString(),
  }));
}

const money = (n) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });

export default async function Page() {
  const sales = await listSales();
  const total = sales.reduce((sum, s) => sum + s.amount, 0);
  const byProduct = new Map();
  for (const s of sales) byProduct.set(s.product, (byProduct.get(s.product) || 0) + s.amount);
  const breakdown = [...byProduct.entries()]
    .map(([product, amount]) => ({ product, amount }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <main>
      <h1>Revenue Dashboard</h1>
      <p className="total-label">Total revenue</p>
      <p className="total">{money(total)}</p>
      <h2>Add a sale</h2>
      <SaleForm />
      <h2>By product</h2>
      <div className="cards">
        {breakdown.map((b) => (
          <div className="card" key={b.product}>
            <div className="name">{b.product}</div>
            <div className="amt">{money(b.amount)}</div>
          </div>
        ))}
      </div>
      <h2>Recent sales</h2>
      <table>
        <thead>
          <tr><th>Product</th><th className="amt">Amount</th><th>When</th></tr>
        </thead>
        <tbody>
          {sales.slice(0, 20).map((s) => (
            <tr key={s.id}>
              <td>{s.product}</td>
              <td className="amt">{money(s.amount)}</td>
              <td>{new Date(s.at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

## services/web/app/sale-form.js

```js
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SaleForm() {
  const router = useRouter();
  const [product, setProduct] = useState("");
  const [amount, setAmount] = useState("");

  async function add(e) {
    e.preventDefault();
    const name = product.trim();
    const value = Number(amount);
    if (!name || !Number.isFinite(value)) return;
    const res = await fetch("/api/sales", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: name, amount: value }),
    });
    if (res.ok) { setProduct(""); setAmount(""); router.refresh(); }
  }

  return (
    <form onSubmit={add} className="row">
      <input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="Product" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" type="number" step="0.01" />
      <button type="submit">Add sale</button>
    </form>
  );
}
```

## services/web/app/api/sales/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function sales() {
  const db = await getDb();
  return db.collection("sales");
}

const shape = (s) => ({
  id: s._id.toString(),
  product: s.product,
  amount: typeof s.amount === "number" ? s.amount : 0,
  at: (s.at instanceof Date ? s.at : new Date(s.at)).toISOString(),
});

export async function GET() {
  const col = await sales();
  const items = await col.find({}).sort({ at: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const product = typeof body.product === "string" ? body.product.trim() : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(body.amount);
  if (!product) return NextResponse.json({ error: "product is required" }, { status: 400 });
  if (!Number.isFinite(amount)) return NextResponse.json({ error: "amount must be a number" }, { status: 400 });
  const col = await sales();
  const doc = { product, amount, at: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ _id: res.insertedId, ...doc }), { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await sales();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `sales` collection to your data (`invoices`, `orders`, `payments`).
- Change the document fields; add currency, region, customer, MRR flags.
- Add a chart, date filters, or per-period rollups.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
```
