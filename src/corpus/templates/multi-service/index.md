# Template: multi-service (static frontend + Node API + Mongo)

A minimal but real, deployable notes app with two services: a static HTML
frontend at `/` and a Node.js/Express API backend at `/api`, sharing a
grid-managed MongoDB. The generic multi-service skeleton for CloudGrid.

**Key rules (all proven by a real end-to-end deploy):**

1. **Each service's code lives under `services/<name>/`.** `path:` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path. The `web` service
   code goes in `services/web/`; the `api` service code goes in `services/api/`.
2. **The platform forwards requests with the path prefix INTACT.** A browser
   fetch to `/api/items` arrives at the `api` service as `/api/items` (with the
   `/api` prefix), not `/items`. Define Express routes with the full prefix:
   `app.get("/api/items", ...)`. This was verified empirically — a route
   registered at just `/items` returns 404 because the incoming path is
   `/api/items`.
3. **The frontend fetches from `/api/...`** — the absolute path, no hostname, no
   port. The platform routes by prefix to the correct service.
4. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as the `DATABASE_MONGODB_URL` environment
   variable (plus the legacy `MONGODB_URL` alias). A top-level read fails the
   build or startup before the grid injects the var.
5. **Declare the datastore with `needs: { database: true }`.** This is the
   canonical shape. The deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
   the deprecated v1 alias; don't author new yaml with it, and never set `needs:`
   and `requires:` together.
6. **Use `depends_on: [api]` on the `web` service** so the API is ready before
   the frontend starts serving traffic.

Write these files into the scaffolded app folder — adapt the collection/fields
to the user's app, then `grid dev` (local) / `grid plug` (deploy, async — poll
to a live URL).

## File tree

```
cloudgrid.yaml                          # name + services(web static, api node) + needs: { database: true }
services/web/index.html                 # static frontend — fetches /api/items
services/api/package.json               # express, mongodb driver
services/api/src/index.js               # Express server — lazy Mongo, CRUD routes at /api/items
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-app
services:
  web:
    type: static
    path: /
    depends_on:
      - api
  api:
    type: node
    path: /api
needs:
  database: true
```

> **Capability:** this template's need is `database: true`. The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias). Two services: `web` (static, at `/`) and `api` (node,
> at `/api`). `requires:` is the deprecated v1 alias — don't mix it with
> `needs:` (the validator rejects the combination).

## services/web/index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Notes</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: system-ui, sans-serif; }
    main { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; }
    .row { display: flex; gap: .5rem; margin-bottom: 1rem; }
    input { flex: 1; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; background: inherit; color: inherit; }
    button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; background: inherit; color: inherit; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { display: flex; justify-content: space-between; align-items: center; padding: .6rem 0; border-bottom: 1px solid #8883; }
    .hint { color: #888; font-size: .875rem; }
    .error { color: #c44; font-size: .875rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Notes</h1>
    <p class="hint">Persisted in grid-shared Mongo via the API service. Survives refresh.</p>
    <div id="error" class="error" hidden></div>
    <form id="form" class="row">
      <input id="text" placeholder="Add a note..." autocomplete="off" />
      <button type="submit">Add</button>
    </form>
    <ul id="list"></ul>
  </main>
  <script>
    const API = '/api/items';
    const listEl = document.getElementById('list');
    const errorEl = document.getElementById('error');

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      setTimeout(() => { errorEl.hidden = true; }, 4000);
    }

    function render(items) {
      listEl.innerHTML = '';
      items.forEach(item => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = item.text;
        const btn = document.createElement('button');
        btn.textContent = 'Delete';
        btn.onclick = () => remove(item.id);
        li.appendChild(span);
        li.appendChild(btn);
        listEl.appendChild(li);
      });
    }

    async function load() {
      try {
        const res = await fetch(API);
        if (!res.ok) throw new Error(res.statusText);
        render(await res.json());
      } catch (e) { showError('Failed to load: ' + e.message); }
    }

    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const input = document.getElementById('text');
      const text = input.value.trim();
      if (!text) return;
      try {
        const res = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(res.statusText);
        input.value = '';
        load();
      } catch (e) { showError('Failed to add: ' + e.message); }
    };

    async function remove(id) {
      try {
        const res = await fetch(API + '/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!res.ok) throw new Error(res.statusText);
        load();
      } catch (e) { showError('Failed to delete: ' + e.message); }
    }

    load();
  </script>
</body>
</html>
```

## services/api/package.json

```json
{
  "name": "api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "mongodb": "^6.12.0"
  }
}
```

## services/api/src/index.js

```js
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());

// Lazy Mongo connection — read the connection string inside the getter, never
// at module top level. The grid injects DATABASE_MONGODB_URL (plus the legacy
// MONGODB_URL alias) at runtime and under `grid dev`.
let clientPromise;
function getClient() {
  if (!clientPromise) {
    const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
    if (!uri) {
      throw new Error(
        "DATABASE_MONGODB_URL is not set. Run with `grid dev` locally or " +
          "deploy with `grid plug` — the grid injects the connection string.",
      );
    }
    clientPromise = new MongoClient(uri).connect();
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db();
}

async function items() {
  const db = await getDb();
  return db.collection("items");
}

// ── Routes ────────────────────────────────────────────────────────────────
// The api service is mounted at path: /api in cloudgrid.yaml. The platform
// forwards requests WITH the /api prefix intact, so routes here must include
// the /api prefix. A browser fetch to /api/items arrives as req.path=/api/items.

app.get("/api/items", async (_req, res) => {
  const col = await items();
  const docs = await col.find({}).sort({ createdAt: -1 }).toArray();
  res.json(docs.map((d) => ({ id: d._id.toString(), text: d.text })));
});

app.post("/api/items", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "text is required" });
  const col = await items();
  const result = await col.insertOne({ text, createdAt: new Date() });
  res.status(201).json({ id: result.insertedId.toString(), text });
});

app.delete("/api/items/:id", async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "invalid id" });
  }
  const col = await items();
  await col.deleteOne({ _id: new ObjectId(id) });
  res.json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: "ok" });
  } catch (e) {
    res.status(503).json({ status: "error", message: e.message });
  }
});

// Diagnostic: echo the received path so agents can verify prefix behavior.
app.use((req, res) => {
  res.status(404).json({ path: req.path, method: req.method, message: "not found" });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`api service listening on port ${port}`);
});
```

## Adapt it

- Rename the `items` collection to your data (`tasks`, `entries`, `messages`).
- Change the document fields; add owners, timestamps, statuses.
- Swap the static frontend for a React/Vite app (add a `build:` step to `web`).
- Swap the Node API for Python (change `type: node` to `type: python`, write a
  FastAPI server in `services/api/src/main.py`).
- Add `cache: true` to `needs:` only if you actually need Redis.
- For a three-service layout (frontend + backend + cron), see `semantic-search`.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
