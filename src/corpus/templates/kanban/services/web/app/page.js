// Home page: a server component reads the cards straight from Mongo, and a small
// client board adds / moves / removes them via the API route. Data persists
// across refresh and across users because it lives in the grid-shared Mongo, not
// in memory.
import { getDb } from "../lib/db.js";
import Board from "./board.js";

export const dynamic = "force-dynamic";

const COLUMNS = ["todo", "doing", "done"];

async function listCards() {
  const db = await getDb();
  const items = await db.collection("cards").find({}).sort({ order: 1, createdAt: 1 }).toArray();
  return items.map((c) => ({
    id: c._id.toString(),
    title: c.title || "",
    column: COLUMNS.includes(c.column) ? c.column : "todo",
    order: typeof c.order === "number" ? c.order : 0,
  }));
}

export default async function Page() {
  const cards = await listCards();
  return (
    <main>
      <h1>Board</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <Board initialCards={cards} />
    </main>
  );
}
