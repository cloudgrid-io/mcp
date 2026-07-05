// Cached MongoDB client for the App Router.
//
// The grid injects the connection string as the MONGODB_URL environment variable
// at runtime (after `grid plug`) and under `grid dev` locally. Never hardcode a
// connection string here and never commit a secret.
//
// The env var and client are resolved LAZILY (inside getDb), never at module top
// level — otherwise `next build` throws when it imports this module for route
// analysis, before the grid injects MONGODB_URL.
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "MONGODB_URL is not set. The grid injects it automatically — run this app " +
        "with `grid dev` locally, or deploy it with `grid plug` (the grid injects " +
        "MONGODB_URL at runtime). Do not set it by hand.",
    );
  }
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  const client = await clientPromise();
  // The default DB comes from the MONGODB_URL path segment the grid injects.
  return client.db();
}
