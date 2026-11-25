const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
// The grid's ingress sits in front of this service, so the client address is
// the one that proxy appends to X-Forwarded-For. Trusting exactly one hop keys
// the rate limit on the real client without letting a caller spoof the header.
app.set("trust proxy", 1);
app.use(express.json());

// Every /api route reads or writes the database, so cap requests per client.
// Generous for a real user; tune `limit` to your app's traffic.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

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

app.get("/api/items", apiLimiter, async (_req, res) => {
  const col = await items();
  const docs = await col.find({}).sort({ createdAt: -1 }).toArray();
  res.json(docs.map((d) => ({ id: d._id.toString(), text: d.text })));
});

app.post("/api/items", apiLimiter, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "text is required" });
  const col = await items();
  const result = await col.insertOne({ text, createdAt: new Date() });
  res.status(201).json({ id: result.insertedId.toString(), text });
});

app.delete("/api/items/:id", apiLimiter, async (req, res) => {
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
