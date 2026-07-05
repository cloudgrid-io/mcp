// Cached MongoDB client for the App Router.
//
// The grid injects the connection string as the MONGODB_URL environment
// variable — at dev-time (`grid dev`) and at runtime (after `grid plug`). Never
// hardcode a connection string here and never commit a secret.
//
// The client is cached on globalThis so Next.js hot-reloads (dev) and lambda
// reuse (prod) share one connection pool instead of opening a new one per
// request.
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URL;
if (!uri) {
  throw new Error(
    "MONGODB_URL is not set. The grid injects it automatically — run this app " +
      "with `grid dev` locally, or deploy it with `grid plug` (the grid injects " +
      "MONGODB_URL at runtime). Do not set it by hand.",
  );
}

// Reuse the client across hot-reloads / invocations.
let clientPromise = globalThis.__mongoClientPromise;
if (!clientPromise) {
  const client = new MongoClient(uri);
  clientPromise = client.connect();
  globalThis.__mongoClientPromise = clientPromise;
}

export async function getDb() {
  const client = await clientPromise;
  // Default DB is taken from the MONGODB_URL path segment the grid injects.
  return client.db();
}

export { clientPromise };
