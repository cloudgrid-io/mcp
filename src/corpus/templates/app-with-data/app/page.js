// Home page: a server component reads the todos straight from Mongo, and a small
// client form adds/removes them via the API route. Data persists across refresh
// and across users because it lives in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import TodoForm from "./todo-form.js";

export const dynamic = "force-dynamic";

async function listTodos() {
  const db = await getDb();
  const items = await db.collection("todos").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((t) => ({ id: t._id.toString(), text: t.text, done: !!t.done }));
}

export default async function Page() {
  const todos = await listTodos();
  return (
    <main>
      <h1>Todos</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <TodoForm initialTodos={todos} />
    </main>
  );
}
