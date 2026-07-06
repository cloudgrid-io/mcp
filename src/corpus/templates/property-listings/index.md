# Template: property-listings (persistent Next.js + Mongo real-estate site)

A minimal but real, deployable property listings site. Listings live in the
grid-shared MongoDB, so they survive refresh and are shared across sessions —
unlike a static page. The domain is a `properties` collection with
`{ title, price:number, location, beds:number, description }`, rendered as a
responsive card grid with a location/price filter, a per-property detail view,
and an admin add form.

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
`services/web/` — adapt the collection/fields to the user's site, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                             # name + services.web (nextjs) + needs: { database: true }
services/web/package.json                  # next, react, react-dom, mongodb driver only
services/web/lib/db.js                     # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js                 # root layout + inline CSS (grid + card styles)
services/web/app/page.js                   # server component: reads/filter properties from Mongo
services/web/app/listings.js               # client: filter controls, card grid, detail view, admin add form
services/web/app/api/properties/route.js   # GET (list + filter) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: property-listings
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
  "name": "property-listings",
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
// (`grid dev`) and runtime (after `grid plug`). The env var and client are
// resolved LAZILY (inside getDb), never at module top level — otherwise
// `next build` throws before the grid injects the var.
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
  title: "Property Listings",
  description: "A persistent property listings site on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 60rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; list-style: none; padding: 0; }
  .card { border: 1px solid #8883; border-radius: .75rem; padding: 1rem; display: flex; flex-direction: column; gap: .35rem; }
  input, select, button, textarea { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; }
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
import Listings from "./listings.js";

export const dynamic = "force-dynamic";

async function listProperties({ location, maxPrice } = {}) {
  const db = await getDb();
  const query = {};
  if (location) query.location = location;
  if (maxPrice && !Number.isNaN(Number(maxPrice))) query.price = { $lte: Number(maxPrice) };
  const items = await db.collection("properties").find(query).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({
    id: p._id.toString(), title: p.title, price: p.price,
    location: p.location, beds: p.beds, description: p.description || "",
  }));
}

export default async function Page({ searchParams }) {
  const sp = (await searchParams) || {};
  const location = typeof sp.location === "string" ? sp.location : "";
  const maxPrice = typeof sp.maxPrice === "string" ? sp.maxPrice : "";
  const db = await getDb();
  const [properties, locations] = await Promise.all([
    listProperties({ location, maxPrice }),
    db.collection("properties").distinct("location"),
  ]);
  return (
    <main>
      <h1>Property Listings</h1>
      <Listings initialProperties={properties} locations={locations.filter(Boolean).sort()}
        activeLocation={location} activeMaxPrice={maxPrice} />
    </main>
  );
}
```

## services/web/app/listings.js

```js
"use client";
import { useState } from "react";

const fmtPrice = (n) => (typeof n === "number" && !Number.isNaN(n) ? "$" + n.toLocaleString() : "");

export default function Listings({ initialProperties, locations, activeLocation, activeMaxPrice }) {
  const [properties, setProperties] = useState(initialProperties);
  const [location, setLocation] = useState(activeLocation || "");
  const [maxPrice, setMaxPrice] = useState(activeMaxPrice || "");
  const [selected, setSelected] = useState(null);

  async function applyFilters(e) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (location) params.set("location", location);
    if (maxPrice) params.set("maxPrice", maxPrice);
    const res = await fetch(`/api/properties?${params.toString()}`);
    if (res.ok) setProperties(await res.json());
  }

  async function addProperty(e) {
    e.preventDefault();
    const form = e.currentTarget, data = new FormData(form);
    const payload = {
      title: (data.get("title") || "").toString().trim(),
      price: Number(data.get("price")), location: (data.get("location") || "").toString().trim(),
      beds: Number(data.get("beds")), description: (data.get("description") || "").toString().trim(),
    };
    if (!payload.title || !payload.location) return;
    const res = await fetch("/api/properties", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (res.ok) { setProperties((p) => [await res.json(), ...p]); form.reset(); }
  }

  async function remove(id) {
    const res = await fetch(`/api/properties?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setProperties((p) => p.filter((x) => x.id !== id));
  }

  if (selected) {
    return (
      <div>
        <button onClick={() => setSelected(null)}>← Back</button>
        <div className="card">
          <h3>{selected.title}</h3>
          <span>{fmtPrice(selected.price)}</span>
          <span>{selected.location} · {selected.beds} beds</span>
          <p>{selected.description}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <form onSubmit={applyFilters}>
        <select value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">Any location</option>
          {locations.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="Max price" />
        <button type="submit">Filter</button>
      </form>
      <ul className="grid">
        {properties.map((p) => (
          <li key={p.id} className="card">
            <h3>{p.title}</h3>
            <span>{fmtPrice(p.price)}</span>
            <span>{p.location} · {p.beds} beds</span>
            <button onClick={() => setSelected(p)}>View</button>
            <button onClick={() => remove(p.id)}>Delete</button>
          </li>
        ))}
      </ul>
      <details>
        <summary>Admin · add a property</summary>
        <form onSubmit={addProperty}>
          <input name="title" placeholder="Title" required />
          <input name="price" type="number" placeholder="Price" required />
          <input name="beds" type="number" placeholder="Beds" required />
          <input name="location" placeholder="Location" required />
          <textarea name="description" placeholder="Description" />
          <button type="submit">Add property</button>
        </form>
      </details>
    </div>
  );
}
```

## services/web/app/api/properties/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function properties() {
  const db = await getDb();
  return db.collection("properties");
}

const toClient = (p) => ({
  id: p._id.toString(), title: p.title, price: p.price,
  location: p.location, beds: p.beds, description: p.description || "",
});

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const location = params.get("location"), maxPrice = params.get("maxPrice");
  const query = {};
  if (location) query.location = location;
  if (maxPrice && !Number.isNaN(Number(maxPrice))) query.price = { $lte: Number(maxPrice) };
  const col = await properties();
  const items = await col.find(query).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(toClient));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const price = Number(body.price), beds = Number(body.beds);
  if (!title || !location) return NextResponse.json({ error: "title and location are required" }, { status: 400 });
  if (Number.isNaN(price) || Number.isNaN(beds)) return NextResponse.json({ error: "price and beds must be numbers" }, { status: 400 });
  const col = await properties();
  const doc = { title, price, location, beds, description: (body.description || "").toString().trim(), createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(toClient({ ...doc, _id: res.insertedId }), { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await properties();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `properties` collection to your data (`rentals`, `homes`).
- Change the document fields; add photos/sqft/status.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
