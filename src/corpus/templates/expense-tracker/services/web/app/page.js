// Home page: a server component reads the expenses straight from Mongo, and a
// small client form adds/removes them via the API route. Data persists across
// refresh and across users because it lives in the grid-shared Mongo, not memory.
import { getDb } from "../lib/db.js";
import ExpenseTracker from "./expense-form.js";

export const dynamic = "force-dynamic";

async function listExpenses() {
  const db = await getDb();
  const items = await db
    .collection("expenses")
    .find({})
    .sort({ date: -1, createdAt: -1 })
    .toArray();
  return items.map((e) => ({
    id: e._id.toString(),
    description: e.description,
    amount: e.amount,
    category: e.category,
    date: e.date,
  }));
}

export default async function Page() {
  const expenses = await listExpenses();
  return (
    <main>
      <h1>Expense Tracker</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <ExpenseTracker initialExpenses={expenses} />
    </main>
  );
}
