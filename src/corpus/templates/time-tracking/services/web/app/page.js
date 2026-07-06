// Home page: a server component reads the time entries straight from Mongo, and a
// small client form adds/removes them via the API route. Data persists across
// refresh and across users because it lives in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import EntryForm from "./entry-form.js";

export const dynamic = "force-dynamic";

async function listEntries() {
  const db = await getDb();
  const items = await db.collection("entries").find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    task: e.task,
    project: e.project,
    minutes: e.minutes,
    date: e.date,
  }));
}

export default async function Page() {
  const entries = await listEntries();
  return (
    <main>
      <h1>Time Tracking</h1>
      <p className="hint">Log billable hours by project — persisted in the grid-shared Mongo, survives refresh.</p>
      <EntryForm initialEntries={entries} />
    </main>
  );
}
