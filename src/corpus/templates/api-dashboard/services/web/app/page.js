// Home page: a server component reads the API request log straight from Mongo,
// computes the header metrics, and a small client component renders the metrics,
// a record form, and the recent-requests table, adding rows via the API route.
// Data persists across refresh and across users because it lives in the
// grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import Dashboard from "./dashboard.js";

export const dynamic = "force-dynamic";

async function listRequests() {
  const db = await getDb();
  const items = await db
    .collection("requests")
    .find({})
    .sort({ at: -1 })
    .limit(50)
    .toArray();
  return items.map((r) => ({
    id: r._id.toString(),
    endpoint: r.endpoint,
    status: r.status,
    ms: r.ms,
    at: r.at instanceof Date ? r.at.toISOString() : r.at,
  }));
}

export default async function Page() {
  const requests = await listRequests();
  return (
    <main>
      <h1>API Dashboard</h1>
      <p className="hint">
        Live request log persisted in grid-shared Mongo — survives refresh.
      </p>
      <Dashboard initialRequests={requests} />
    </main>
  );
}
