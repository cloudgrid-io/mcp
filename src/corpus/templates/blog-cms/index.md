# Template: blog-cms (persistent Next.js + Mongo blog / CMS)

A minimal but real, deployable blog / content site. Posts live in the
grid-shared MongoDB, so they survive refresh and are shared across sessions —
unlike a static page. It is the proven `app-with-data` shape adapted to a
`posts` domain: a public post list, a single-post page, and an admin
create/delete screen.

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
4. **API routes and DB-reading pages are `export const dynamic = "force-dynamic"`**
   so they always read/write live data instead of being statically prerendered.

Write these files into the scaffolded app folder — the app code goes under
`services/web/` — adapt the collection/fields to the user's site, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## Domain

A `posts` collection: `{ title, slug, body, tags: string[], published: boolean,
createdAt: Date }`. Pages: `/` (published list), `/posts/[slug]` (single post),
`/admin` (create/delete, drafts included).

## File tree

```
cloudgrid.yaml                              # name + services.web (nextjs) + needs: { database: true }
services/web/package.json                   # next, react, react-dom, mongodb driver only
services/web/lib/db.js                      # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js                  # root layout + inline CSS
services/web/app/page.js                    # server component: public list of published posts
services/web/app/posts/[slug]/page.js       # server component: single published post
services/web/app/admin/page.js              # server component: admin list (drafts + published)
services/web/app/admin/admin-editor.js      # client form: create/delete via the API
services/web/app/api/posts/route.js         # GET (list) / POST (create) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: blog-cms
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
  "name": "blog-cms",
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
// string as DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). Read it
// LAZILY inside getDb — never at module top level, or `next build` throws when
// it imports this module for route analysis before the grid injects the var.
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
  title: "Blog",
  description: "A persistent blog / CMS on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.6; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  article { padding: 1.25rem 0; border-bottom: 1px solid #8883; }
  .tag { display: inline-block; padding: .1rem .5rem; margin-right: .3rem; border: 1px solid #8886; border-radius: 1rem; }
  .draft { color: #b45; margin-left: .5rem; text-transform: uppercase; font-size: .7rem; }
  .post-body { white-space: pre-wrap; }
  form.admin { display: grid; gap: .6rem; padding: 1.25rem; border: 1px solid #8886; border-radius: .75rem; }
  input, textarea { width: 100%; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
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
import Link from "next/link";
import { getDb } from "../lib/db.js";

export const dynamic = "force-dynamic";

async function listPublished() {
  const db = await getDb();
  const items = await db.collection("posts").find({ published: true }).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({ id: p._id.toString(), title: p.title, slug: p.slug, tags: p.tags || [] }));
}

export default async function Page() {
  const posts = await listPublished();
  return (
    <main>
      <h1>Blog</h1>
      <nav><Link href="/admin">Admin</Link></nav>
      {posts.length === 0 && <p className="empty">No published posts yet.</p>}
      {posts.map((p) => (
        <article key={p.id}>
          <h2><Link href={`/posts/${encodeURIComponent(p.slug)}`}>{p.title}</Link></h2>
          <p className="tags">{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</p>
        </article>
      ))}
    </main>
  );
}
```

## services/web/app/posts/[slug]/page.js

```js
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function getPost(slug) {
  const db = await getDb();
  const p = await db.collection("posts").findOne({ slug, published: true });
  return p ? { title: p.title, body: p.body, tags: p.tags || [] } : null;
}

export default async function PostPage({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  return (
    <main>
      <nav><Link href="/">← All posts</Link></nav>
      <h1>{post.title}</h1>
      <div className="post-body">{post.body}</div>
    </main>
  );
}
```

## services/web/app/admin/page.js

```js
import Link from "next/link";
import { getDb } from "../../lib/db.js";
import AdminEditor from "./admin-editor.js";

export const dynamic = "force-dynamic";

async function listAll() {
  const db = await getDb();
  const items = await db.collection("posts").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({ id: p._id.toString(), title: p.title, slug: p.slug, published: !!p.published }));
}

export default async function AdminPage() {
  const posts = await listAll();
  return (
    <main>
      <h1>Admin</h1>
      <nav><Link href="/">← View blog</Link></nav>
      <AdminEditor initialPosts={posts} />
    </main>
  );
}
```

## services/web/app/admin/admin-editor.js

```js
"use client";
import { useState } from "react";

export default function AdminEditor({ initialPosts }) {
  const [posts, setPosts] = useState(initialPosts);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [published, setPublished] = useState(true);

  async function create(e) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title.trim(), slug: slug.trim(), body: body.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean), published,
      }),
    });
    if (res.ok) { setPosts((p) => [await res.json(), ...p]); setTitle(""); setSlug(""); setBody(""); setTags(""); }
  }

  async function remove(id) {
    const res = await fetch(`/api/posts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) setPosts((p) => p.filter((x) => x.id !== id));
  }

  return (
    <div>
      <form onSubmit={create} className="admin">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug (optional)" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma, separated" />
        <label><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Published</label>
        <button type="submit">Create post</button>
      </form>
      {posts.map((p) => (
        <article key={p.id}>
          <h2>{p.title}{!p.published && <span className="draft">draft</span>}</h2>
          <button type="button" onClick={() => remove(p.id)}>Delete</button>
        </article>
      ))}
    </div>
  );
}
```

## services/web/app/api/posts/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function posts() {
  const db = await getDb();
  return db.collection("posts");
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function serialize(p) {
  return { id: p._id.toString(), title: p.title, slug: p.slug, body: p.body,
    tags: p.tags || [], published: !!p.published };
}

export async function GET() {
  const col = await posts();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

export async function POST(request) {
  const data = await request.json().catch(() => ({}));
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (!title || !body) return NextResponse.json({ error: "title and body are required" }, { status: 400 });
  const slug = (typeof data.slug === "string" && data.slug.trim() && slugify(data.slug)) || slugify(title);
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const published = data.published !== false;
  const col = await posts();
  if (await col.findOne({ slug })) return NextResponse.json({ error: "slug already exists" }, { status: 409 });
  const doc = { title, slug, body, tags, published, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await posts();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `posts` collection to your data (`articles`, `pages`, `entries`).
- Change the document fields; add author, updatedAt, cover image.
- Add an edit/PATCH route, categories, or pagination.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
