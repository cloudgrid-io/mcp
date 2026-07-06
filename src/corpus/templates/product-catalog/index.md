# Template: product-catalog (Next.js + Mongo product catalog)

A minimal but real, deployable product catalog. Products live in the grid-shared
MongoDB, so they survive refresh and are shared across sessions — unlike a static
page. Visitors browse a product grid and filter by category; an admin section
adds and deletes products. No checkout.

Domain: `products` collection — `{ name, price, category, description, inStock }`.

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
cloudgrid.yaml                            # name + services.web (nextjs) + needs: { database: true }
services/web/package.json                 # next, react, react-dom, mongodb driver only
services/web/lib/db.js                    # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js                # root layout + inline CSS
services/web/app/page.js                  # server component: reads products from Mongo
services/web/app/catalog.js               # client grid + category filter + admin add/delete form
services/web/app/api/products/route.js    # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: product-catalog
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
  "name": "product-catalog",
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
// string as DATABASE_MONGODB_URL (legacy MONGODB_URL alias) at dev-time and
// runtime. Read it LAZILY inside getDb — never at module top level, or
// `next build` throws when it imports this module for route analysis.
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
  title: "Product Catalog",
  description: "A product catalog on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  .filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  .chip { padding: .35rem .8rem; border: 1px solid #8886; border-radius: 999px; background: none; cursor: pointer; }
  .chip.active { background: #6663; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .card { border: 1px solid #8883; border-radius: .75rem; padding: 1rem; display: flex; flex-direction: column; gap: .4rem; }
  .price { font-size: 1.15rem; font-weight: 600; }
  .stock.in { color: #2a8a2a; } .stock.out { color: #b03535; }
  input, select, textarea { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
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
import Catalog from "./catalog.js";

export const dynamic = "force-dynamic";

async function listProducts() {
  const db = await getDb();
  const items = await db.collection("products").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({
    id: p._id.toString(),
    name: p.name,
    price: typeof p.price === "number" ? p.price : 0,
    category: p.category || "Uncategorized",
    description: p.description || "",
    inStock: !!p.inStock,
  }));
}

export default async function Page() {
  const products = await listProducts();
  return (
    <main>
      <h1>Product Catalog</h1>
      <p className="hint">Browse products by category — persisted in the grid-shared Mongo.</p>
      <Catalog initialProducts={products} />
    </main>
  );
}
```

## services/web/app/catalog.js

```js
"use client";
import { useState, useMemo } from "react";

const ALL = "All";
const formatPrice = (n) => "$" + Number(n || 0).toFixed(2);

export default function Catalog({ initialProducts }) {
  const [products, setProducts] = useState(initialProducts);
  const [active, setActive] = useState(ALL);
  const [form, setForm] = useState({ name: "", price: "", category: "", description: "", inStock: true });

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return [ALL, ...Array.from(set).sort()];
  }, [products]);
  const visible = useMemo(
    () => (active === ALL ? products : products.filter((p) => p.category === active)),
    [products, active],
  );

  async function add(e) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) return;
    const res = await fetch("/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name, price: parseFloat(form.price) || 0,
        category: form.category.trim() || "Uncategorized",
        description: form.description.trim(), inStock: form.inStock,
      }),
    });
    if (res.ok) {
      setProducts((prev) => [await res.json(), ...prev]);
      setForm({ name: "", price: "", category: "", description: "", inStock: true });
    }
  }

  async function remove(id) {
    const res = await fetch(`/api/products?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setProducts((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div>
      <div className="filters">
        {categories.map((c) => (
          <button key={c} type="button" className={"chip" + (c === active ? " active" : "")} onClick={() => setActive(c)}>{c}</button>
        ))}
      </div>
      <div className="grid">
        {visible.length === 0 && <p className="empty">No products yet.</p>}
        {visible.map((p) => (
          <div className="card" key={p.id}>
            <span className="cat">{p.category}</span>
            <h3>{p.name}</h3>
            <span className="price">{formatPrice(p.price)}</span>
            {p.description && <p className="desc">{p.description}</p>}
            <div className="foot">
              <span className={"stock " + (p.inStock ? "in" : "out")}>{p.inStock ? "In stock" : "Out of stock"}</span>
              <button type="button" className="del" onClick={() => remove(p.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      <div className="admin">
        <h2>Add a product</h2>
        <form onSubmit={add}>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name" />
          <input value={form.price} type="number" step="0.01" min="0" onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="Price" />
          <input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder="Category" />
          <label className="check"><input type="checkbox" checked={form.inStock} onChange={(e) => setForm((f) => ({ ...f, inStock: e.target.checked }))} /> In stock</label>
          <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Description" />
          <button type="submit">Add product</button>
        </form>
      </div>
    </div>
  );
}
```

## services/web/app/api/products/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function products() {
  const db = await getDb();
  return db.collection("products");
}

function serialize(p) {
  return {
    id: p._id.toString(),
    name: p.name,
    price: typeof p.price === "number" ? p.price : 0,
    category: p.category || "Uncategorized",
    description: p.description || "",
    inStock: !!p.inStock,
  };
}

export async function GET() {
  const col = await products();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const doc = {
    name,
    price: typeof body.price === "number" && isFinite(body.price) ? body.price : 0,
    category: typeof body.category === "string" && body.category.trim() ? body.category.trim() : "Uncategorized",
    description: typeof body.description === "string" ? body.description.trim() : "",
    inStock: body.inStock !== false,
    createdAt: new Date(),
  };
  const col = await products();
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ ...doc, _id: res.insertedId }), { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await products();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `products` collection to your data (`items`, `inventory`, `listings`).
- Change the document fields; add SKU, image URL, tags.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
