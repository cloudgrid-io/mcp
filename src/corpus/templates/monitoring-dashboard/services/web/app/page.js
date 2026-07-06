// Home page: a server component reads the checks straight from Mongo, derives a
// current-status grid (latest check per service) plus a recent history, and a
// small client form posts new checks via the API route. Data persists across
// refresh and across users because it lives in the grid-shared Mongo, not memory.
import { getDb } from "../lib/db.js";
import CheckForm from "./check-form.js";

export const dynamic = "force-dynamic";

async function listChecks() {
  const db = await getDb();
  const items = await db
    .collection("checks")
    .find({})
    .sort({ at: -1 })
    .limit(200)
    .toArray();
  return items.map((c) => ({
    id: c._id.toString(),
    service: c.service,
    status: c.status,
    latencyMs: c.latencyMs,
    at: (c.at instanceof Date ? c.at : new Date(c.at)).toISOString(),
  }));
}

// Latest check per service = the current status grid.
function currentStatus(checks) {
  const seen = new Map();
  for (const c of checks) {
    if (!seen.has(c.service)) seen.set(c.service, c);
  }
  return [...seen.values()].sort((a, b) => a.service.localeCompare(b.service));
}

export default async function Page() {
  const checks = await listChecks();
  const services = currentStatus(checks);
  return (
    <main>
      <h1>Monitoring Dashboard</h1>
      <p className="hint">
        Service health from the grid-shared Mongo — status grid + recent history,
        survives refresh.
      </p>
      <CheckForm initialChecks={checks} initialServices={services} />
    </main>
  );
}
