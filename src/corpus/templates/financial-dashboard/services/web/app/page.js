// Home page: a server component reads the entries straight from Mongo, computes
// the income / expense / net totals, and a small client board adds/removes them
// via the API route. Data persists across refresh and across users because it
// lives in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import EntryBoard from "./entry-board.js";

export const dynamic = "force-dynamic";

async function listEntries() {
  const db = await getDb();
  const items = await db.collection("entries").find({}).sort({ at: -1 }).toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    account: e.account,
    amount: e.amount,
    type: e.type,
    at: e.at instanceof Date ? e.at.toISOString() : e.at,
  }));
}

export default async function Page() {
  const entries = await listEntries();
  return (
    <main>
      <h1>Financial Dashboard</h1>
      <p className="hint">P&amp;L / cashflow board — persisted in grid-shared Mongo, survives refresh.</p>
      <EntryBoard initialEntries={entries} />
    </main>
  );
}
