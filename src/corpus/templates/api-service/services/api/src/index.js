// A minimal REST/JSON API backed by grid-shared Mongo.
//
// Endpoints (resource: `items`):
//   GET    /items      -> list items (newest first)
//   POST   /items      -> create an item; body { "text": string }
//   DELETE /items?id=…  -> remove an item by id
//   GET    /           -> tiny service banner + endpoint list
//
// The grid injects the connection string as the DATABASE_MONGODB_URL environment
// variable (plus the legacy MONGODB_URL alias) at dev-time (`grid dev`) and
// runtime (after `grid plug`). Read the canonical var first, fall back to the
// legacy alias.
//
// The env var and Mongo client are resolved LAZILY (inside getDb), never at
// module top level — a top-level read throws at node startup, before the grid
// has injected the var, and crashes the service. Never hardcode a connection
// string here and never commit a secret.
import { createServer } from "node:http";
import { MongoClient, ObjectId } from "mongodb";

let clientPromise;

function getClient() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it automatically — run " +
        "this service with `grid dev` locally, or deploy it with `grid plug` (the " +
        "grid injects the DB connection string at runtime). Do not set it by hand.",
    );
  }
  if (!clientPromise) clientPromise = new MongoClient(uri).connect();
  return clientPromise;
}

async function items() {
  const client = await getClient();
  // The default DB comes from the connection-string path segment the grid injects.
  return client.db().collection("items");
}

// ── Small JSON helpers ───────────────────────────────────────────────────────
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
      if (data.length > 1_000_000) req.destroy(); // basic guard
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null); // signal invalid JSON
      }
    });
    req.on("error", () => resolve(null));
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
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
    // Never leak internals or a connection string in the response.
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
  });
});

// The grid injects PORT; default to 8080 for local runs.
const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`api-service listening on :${port}`);
});
