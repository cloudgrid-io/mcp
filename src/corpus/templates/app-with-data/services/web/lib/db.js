// Cached MongoDB client for the App Router.
//
// The grid injects the connection string as the DATABASE_MONGODB_URL environment
// variable (plus the legacy MONGODB_URL alias) at dev-time (`grid dev`) and
// runtime (after `grid plug`). Read the canonical var first, fall back to the
// legacy alias. Never hardcode a connection string here and never commit a secret.
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
