// Home page: a server component reads the tasks straight from Mongo, and a small
// client list toggles / adds / removes them via the API route. Data persists
// across refresh and across users because it lives in the grid-shared Mongo, not
// in memory.
import { getDb } from "../lib/db.js";
import TaskList from "./task-list.js";

export const dynamic = "force-dynamic";

const PRIORITIES = ["low", "medium", "high"];

async function listTasks() {
  const db = await getDb();
  const items = await db.collection("tasks").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((t) => ({
    id: t._id.toString(),
    title: t.title || "",
    done: !!t.done,
    due: t.due || "",
    priority: PRIORITIES.includes(t.priority) ? t.priority : "medium",
  }));
}

export default async function Page() {
  const tasks = await listTasks();
  return (
    <main>
      <h1>Tasks</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>
      <TaskList initialTasks={tasks} />
    </main>
  );
}
