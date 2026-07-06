// Home page: a server component reads the feature requests straight from Mongo,
// and a small client component renders the board with upvote + add via the API
// route. Data persists across refresh and across users because it lives in the
// grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import Board from "./board.js";

export const dynamic = "force-dynamic";

async function listRequests() {
  const db = await getDb();
  const items = await db
    .collection("requests")
    .find({})
    .sort({ votes: -1, createdAt: -1 })
    .toArray();
  return items.map((r) => ({
    id: r._id.toString(),
    title: r.title,
    description: r.description || "",
    votes: r.votes || 0,
    status: r.status || "open",
  }));
}

export default async function Page() {
  const requests = await listRequests();
  return (
    <main>
      <h1>Feature Requests</h1>
      <p className="hint">Upvote what matters, add your own — persisted in the grid-shared Mongo.</p>
      <Board initialRequests={requests} />
    </main>
  );
}
