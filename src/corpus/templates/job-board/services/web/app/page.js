// Home page: a server component reads the jobs straight from Mongo, and a small
// client component posts / removes them via the API route. Data persists across
// refresh and across users because it lives in the grid-shared Mongo, not in
// memory.
import { getDb } from "../lib/db.js";
import JobBoard from "./job-board.js";

export const dynamic = "force-dynamic";

async function listJobs() {
  const db = await getDb();
  const items = await db.collection("jobs").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((j) => ({
    id: j._id.toString(),
    title: j.title || "",
    company: j.company || "",
    location: j.location || "",
    type: j.type || "",
    url: j.url || "",
  }));
}

export default async function Page() {
  const jobs = await listJobs();
  return (
    <main>
      <h1>Open roles</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <JobBoard initialJobs={jobs} />
    </main>
  );
}
