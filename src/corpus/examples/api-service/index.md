# Example: api-service — "Notes API"

A filled reference imitating the `api-service` template: a small REST/JSON
backend for notes. Same stack (a plain Node `http` server + the `mongodb`
driver, grid-shared Mongo via `process.env.DATABASE_MONGODB_URL`), slightly
richer than the bare items template — notes have a `title` and a `body`, and the
API supports fetching a single note and updating it via PUT.

Data persists in the grid-shared Mongo, so every caller sees the same notes
across sessions and refresh.

**Same four proven rules as the template:** (1) service code lives under
**`services/api/`** (the service name, NOT the repo root — `path:` is the URL
mount); (2) the DB connection string is read **lazily inside the `getClient`
getter**, never at module top level (a top-level read crashes node startup); (3)
the datastore is declared with the canonical **`needs: { database: true }`** —
the deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
`MONGODB_URL` alias); (4) the server listens on **`process.env.PORT || 8080`**.
Don't use the deprecated `requires:` alias.

## cloudgrid.yaml

```yaml
# `needs: { database: true }` is canonical: the deployer provisions Mongo and
# injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). `requires:`
# is the deprecated v1 alias — don't mix the two (the validator rejects it).
# Plain Node HTTP service; code lives under services/api/.
name: notes-api
services:
  api:
    type: node
    path: /
needs:
  database: true
```

## services/api/package.json

```json
{
  "name": "api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.js",
  "scripts": { "start": "node src/index.js" },
  "dependencies": { "mongodb": "^6.12.0" }
}
```

## services/api/src/index.js

```js
// Notes REST API backed by grid-shared Mongo.
//   GET    /notes        -> list notes (newest first)
//   POST   /notes        -> create a note; body { title, body }
//   GET    /notes/:id    -> fetch one note
//   PUT    /notes/:id    -> update a note; body { title?, body? }
//   DELETE /notes/:id    -> remove a note
//
// The grid injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias) at
// dev + runtime. The env var and Mongo client are resolved LAZILY inside
// getClient, never at module top level — a top-level read crashes node startup
// before the grid injects the var. Never hardcode a connection string or secret.
import { createServer } from "node:http";
import { MongoClient, ObjectId } from "mongodb";

let clientPromise;

function getClient() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it — run `grid dev` " +
        "locally or deploy with `grid plug`. Do not set it by hand.",
    );
  }
  if (!clientPromise) clientPromise = new MongoClient(uri).connect();
  return clientPromise;
}

async function notes() {
  return (await getClient()).db().collection("notes");
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
    req.on("data", (c) => {
      data += c;
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

function shape(n) {
  return { id: n._id.toString(), title: n.title, body: n.body, updatedAt: n.updatedAt };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["notes"] or ["notes", "<id>"]
  const col = await notes();

  if (parts[0] !== "notes") return sendJson(res, 404, { error: "not found" });

  // Collection: /notes
  if (parts.length === 1) {
    if (req.method === "GET") {
      const list = await col.find({}).sort({ updatedAt: -1 }).toArray();
      return sendJson(res, 200, list.map(shape));
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (body === null) return sendJson(res, 400, { error: "invalid JSON body" });
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return sendJson(res, 400, { error: "title is required" });
      const doc = { title, body: typeof body.body === "string" ? body.body : "", updatedAt: new Date() };
      const { insertedId } = await col.insertOne(doc);
      return sendJson(res, 201, shape({ _id: insertedId, ...doc }));
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  // Item: /notes/:id
  const id = parts[1];
  if (!ObjectId.isValid(id)) return sendJson(res, 400, { error: "invalid id" });
  const _id = new ObjectId(id);

  if (req.method === "GET") {
    const note = await col.findOne({ _id });
    if (!note) return sendJson(res, 404, { error: "note not found" });
    return sendJson(res, 200, shape(note));
  }
  if (req.method === "PUT") {
    const body = await readBody(req);
    if (body === null) return sendJson(res, 400, { error: "invalid JSON body" });
    const $set = { updatedAt: new Date() };
    if (typeof body.title === "string") $set.title = body.title.trim();
    if (typeof body.body === "string") $set.body = body.body;
    const r = await col.findOneAndUpdate({ _id }, { $set }, { returnDocument: "after" });
    if (!r) return sendJson(res, 404, { error: "note not found" });
    return sendJson(res, 200, shape(r));
  }
  if (req.method === "DELETE") {
    const { deletedCount } = await col.deleteOne({ _id });
    if (deletedCount === 0) return sendJson(res, 404, { error: "note not found" });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => console.log(`notes-api listening on :${port}`));
```

## Notes

- Deploy the same way as the template: `grid dev` locally, `grid plug` to deploy
  (async — poll status to a live URL). Re-plug the same entity to keep one URL.
- The only store this needs is Mongo (`needs: { database: true }` — the deployer
  provisions Mongo and injects `DATABASE_MONGODB_URL`, plus the legacy
  `MONGODB_URL` alias). Add more `needs:` only for infra you actually use.
- All service code lives under `services/api/`; the connection is read lazily
  inside `getClient`, never at module top level; the server listens on
  `process.env.PORT || 8080`.
