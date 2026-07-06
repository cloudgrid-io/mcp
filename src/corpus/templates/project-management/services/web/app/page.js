// Home page: a server component reads projects (and, for the selected project, its
// tasks) straight from Mongo. A client component adds/removes projects and manages
// the task board via the API routes. Data persists across refresh and across users
// because it lives in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import Board from "./board.js";

export const dynamic = "force-dynamic";

async function listProjects() {
  const db = await getDb();
  const items = await db.collection("projects").find({}).sort({ createdAt: -1 }).toArray();
  return items.map((p) => ({ id: p._id.toString(), name: p.name }));
}

async function listTasks(projectId) {
  const db = await getDb();
  const items = await db
    .collection("tasks")
    .find({ projectId })
    .sort({ createdAt: -1 })
    .toArray();
  return items.map((t) => ({
    id: t._id.toString(),
    projectId: t.projectId,
    title: t.title,
    status: t.status,
    assignee: t.assignee || "",
  }));
}

export default async function Page({ searchParams }) {
  const projects = await listProjects();
  const sp = await searchParams;
  const selectedId =
    (sp && sp.project && projects.some((p) => p.id === sp.project) && sp.project) ||
    (projects[0] && projects[0].id) ||
    null;
  const tasks = selectedId ? await listTasks(selectedId) : [];
  return (
    <main>
      <h1>Projects</h1>
      <p className="hint">
        A team project &amp; task board persisted in the grid-shared Mongo — survives refresh.
      </p>
      <Board initialProjects={projects} initialSelectedId={selectedId} initialTasks={tasks} />
    </main>
  );
}
