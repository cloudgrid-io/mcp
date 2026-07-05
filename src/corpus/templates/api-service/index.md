# Template: api-service (Node HTTP + Mongo REST API)

A minimal but real, deployable backend API. A plain Node `http` server (no web
UI, no framework) serving a small REST resource (`/items`) backed by the
grid-shared MongoDB. Data survives refresh and is shared across sessions. This is
the plain-service sibling of `app-with-data` — use it when the user wants a
backend/API, not a full web app.

**Key rules (all proven by a real end-to-end deploy):**

1. **Service code MUST live under `services/<name>/`, not the repo/template
   root.** `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
   The service named `api` → the CLI looks for `services/api/`. Files at the root
   fail with `Error: Service directory not found: …/services/api`.
2. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as the `DATABASE_MONGODB_URL` environment
   variable (plus the legacy `MONGODB_URL` alias) at dev-time and runtime; the
   service reads `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`
   inside `getClient`. A top-level `const uri = process.env.DATABASE_MONGODB_URL;
   if (!uri) throw` crashes node startup before the grid injects the var. Never
   hardcode a connection string; never commit a secret.
3. **Declare the datastore with `needs: { database: true }`.** This is the
   canonical shape — the deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
   the deprecated v1 alias; don't author new yaml with it, and never set `needs:`
   and `requires:` together (the validator rejects the combination).
4. **Listen on `process.env.PORT || 8080`.** The grid injects `PORT`; the `8080`
   default is for local runs.

Write these files into the scaffolded app folder — the service code goes under
`services/api/` — adapt the resource/fields to the user's API, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                 # name + services.api (node) + needs: { database: true }
services/api/package.json      # type: module, main src/index.js, mongodb driver only
services/api/src/index.js      # Node http server on PORT||8080; /items GET/POST/DELETE on Mongo
```

## cloudgrid.yaml

```yaml
# Rename this service. The grid injects the DB connection string as an
# environment variable at runtime — do NOT set it yourself, and never commit a
# connection string or secret.
#
# `needs: { database: true }` is the canonical, recommended shape. The deployer
# provisions Mongo and injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL
# alias). `requires:` is the deprecated v1 alias — don't author new yaml with it,
# and never set `needs:` and `requires:` together (the validator rejects it).
#
# This is a plain Node HTTP service (type: node), not a web UI. Service code lives
# under services/api/ — `path:` is the URL mount, not the filesystem path.
name: my-api
services:
  api:
    type: node
    path: /
needs:
  database: true
```

> **Capability:** this template's need is `database: true`. The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias), so a service reading either var works. `requires:` is the
> deprecated v1 alias — don't mix it with `needs:` (the validator rejects the
> combination). See the capability-map for the full injection table.

## services/api/package.json

```json
{
  "name": "api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "mongodb": "^6.12.0"
  }
}
```

## services/api/src/index.js

```js
// A minimal REST/JSON API backed by grid-shared Mongo.
//
// Endpoints (resource: `items`):
//   GET    /items      -> list items (newest first)
//   POST   /items      -> create an item; body { "text": string }
//   DELETE /items?id=…  -> remove an item by id
//   GET    /           -> tiny service banner + endpoint list
//
// The grid injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias) at
// dev + runtime. The env var and Mongo client are resolved LAZILY (inside
// getClient), never at module top level — a top-level read throws at node
// startup, before the grid injects the var, and crashes the service. Never
// hardcode a connection string; never commit a secret.
import { createServer } from "node:http";
import { MongoClient, ObjectId } from "mongodb";

let clientPromise;

function getClient() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it automatically — run " +
        "this service with `grid dev` locally, or deploy it with `grid plug`. Do " +
        "not set it by hand.",
    );
  }
  if (!clientPromise) clientPromise = new MongoClient(uri).connect();
  return clientPromise;
}

async function items() {
  const client = await getClient();
  return client.db().collection("items");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  if (pathname === "/" && req.method === "GET") {
    return sendJson(res, 200, {
      service: "my-api",
      endpoints: ["GET /items", "POST /items", "DELETE /items?id=<id>"],
    });
  }

  if (pathname === "/items") {
    const col = await items();

    if (req.method === "GET") {
      const list = await col.find({}).sort({ createdAt: -1 }).toArray();
      return sendJson(
        res,
        200,
        list.map((it) => ({ id: it._id.toString(), text: it.text, createdAt: it.createdAt })),
      );
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (body === null) return sendJson(res, 400, { error: "invalid JSON body" });
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return sendJson(res, 400, { error: "text is required" });
      const doc = { text, createdAt: new Date() };
      const { insertedId } = await col.insertOne(doc);
      return sendJson(res, 201, { id: insertedId.toString(), ...doc });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id || !ObjectId.isValid(id)) {
        return sendJson(res, 400, { error: "a valid id query param is required" });
      }
      const { deletedCount } = await col.deleteOne({ _id: new ObjectId(id) });
      if (deletedCount === 0) return sendJson(res, 404, { error: "item not found" });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: "method not allowed" });
  }

  return sendJson(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`api-service listening on :${port}`);
});
```

## Adapt it

- Rename the `items` collection in `services/api/src/index.js` to your resource
  (`notes`, `orders`, `events`).
- Change the document fields; add validation, owners, timestamps, statuses.
- Add more routes/resources as the API grows.
- Return clear JSON errors (`{ "error": … }`) with the right status codes.
- Add more `needs:` (e.g. `cache: true`) only if you actually use them.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
