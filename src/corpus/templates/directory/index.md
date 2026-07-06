# Template: directory (searchable Next.js + Mongo directory)

A minimal but real, deployable directory app: a searchable, filterable list of
listings (name, category, url, description) with add + delete. Data lives in the
grid-shared MongoDB, so it survives refresh and is shared across sessions —
unlike a static page. Fits business directories, member directories, and
listings directories.

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
`services/web/` — adapt the collection/fields to the user's directory, then
`grid dev` (local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                   # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js               # root layout + inline CSS
services/web/app/page.js                 # server component: reads entries from Mongo
services/web/app/directory-list.js       # client component: search/filter + add/delete via the API
services/web/app/api/entries/route.js    # GET (list) / POST (add) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-directory
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
  "name": "my-directory",
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
  title: "Directory",
  description: "A searchable directory of listings on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  form.add { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 1.5rem; }
  form.add textarea { grid-column: span 2; }
  .filters { display: flex; gap: .5rem; margin-bottom: 1rem; }
  input, textarea, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; justify-content: space-between; gap: 1rem; padding: .8rem 0; border-bottom: 1px solid #8883; }
  .cat { font-size: .75rem; padding: .1rem .5rem; border: 1px solid #8886; border-radius: 1rem; }
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
import DirectoryList from "./directory-list.js";

export const dynamic = "force-dynamic";

async function listEntries() {
  const db = await getDb();
  const items = await db.collection("entries").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    name: e.name,
    category: e.category || "",
    url: e.url || "",
    description: e.description || "",
  }));
}

export default async function Page() {
  const entries = await listEntries();
  return (
    <main>
      <h1>Directory</h1>
      <p className="hint">A searchable, filterable directory — persisted in the grid-shared Mongo.</p>
      <DirectoryList initialEntries={entries} />
    </main>
  );
}
```

## services/web/app/directory-list.js

```js
"use client";
import { useMemo, useState } from "react";

export default function DirectoryList({ initialEntries }) {
  const [entries, setEntries] = useState(initialEntries);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [filterCat, setFilterCat] = useState("");

  const categories = useMemo(
    () => Array.from(new Set(entries.map((e) => e.category).filter(Boolean))).sort(),
    [entries],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filterCat && e.category !== filterCat) return false;
      if (!q) return true;
      return [e.name, e.category, e.description, e.url].some((f) => f.toLowerCase().includes(q));
    });
  }, [entries, query, filterCat]);

  async function add(e) {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    const res = await fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: value, category: category.trim(), url: url.trim(), description: description.trim() }),
    });
    if (res.ok) {
      setEntries((p) => [await res.json(), ...p]);
      setName(""); setCategory(""); setUrl(""); setDescription("");
    }
  }

  async function remove(id) {
    const res = await fetch(`/api/entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setEntries((p) => p.filter((e) => e.id !== id));
  }

  return (
    <div>
      <form onSubmit={add} className="add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL (https://…)" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" />
        <div className="actions"><button type="submit">Add entry</button></div>
      </form>
      <div className="filters">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" />
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <ul>
        {visible.map((e) => (
          <li key={e.id}>
            <div className="entry-main">
              <div className="entry-head">
                <span className="entry-name">{e.name}</span>
                {e.category && <span className="cat">{e.category}</span>}
              </div>
              {e.url && <a href={e.url} target="_blank" rel="noreferrer">{e.url}</a>}
              {e.description && <p className="entry-desc">{e.description}</p>}
            </div>
            <button type="button" onClick={() => remove(e.id)}>Delete</button>
          </li>
        ))}
      </ul>
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
    name: e.name,
    category: e.category || "",
    url: e.url || "",
    description: e.description || "",
  };
}

export async function GET() {
  const col = await entries();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const doc = {
    name,
    category: typeof body.category === "string" ? body.category.trim() : "",
    url: typeof body.url === "string" ? body.url.trim() : "",
    description: typeof body.description === "string" ? body.description.trim() : "",
    createdAt: new Date(),
  };
  const col = await entries();
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

- Rename the `entries` collection to your data (`members`, `businesses`, `listings`).
- Change the document fields; add tags/contact/location/timestamps.
- Extend filtering/sorting, or add an edit (PATCH) route.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
