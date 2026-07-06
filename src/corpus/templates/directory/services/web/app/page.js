// Home page: a server component reads the entries straight from Mongo, and a
// small client component filters/searches them and adds/removes them via the API
// route. Data persists across refresh and across users because it lives in the
// grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import DirectoryList from "./directory-list.js";

export const dynamic = "force-dynamic";

async function listEntries() {
  const db = await getDb();
  const items = await db
    .collection("entries")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    name: e.name,
    category: e.category || "",
    url: e.url || "",
    description: e.description || "",
  }));
}

export default async function Page() {
  const entries = await listEntries();
  return (
    <main>
      <h1>Directory</h1>
      <p className="hint">
        A searchable, filterable directory — persisted in the grid-shared Mongo,
        so it survives refresh and is shared across sessions.
      </p>
      <DirectoryList initialEntries={entries} />
    </main>
  );
}
