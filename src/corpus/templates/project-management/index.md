# Template: project-management (team project & task board, Next.js + Mongo)

A minimal but real, deployable project management app: **projects** plus a
per-project **task board** with three status columns (to do / doing / done) and an
optional assignee per task. Data lives in the grid-shared MongoDB, so it survives
refresh and is shared across sessions — unlike a static page.

Domain:

- **projects** — `{ name }`
- **tasks** — `{ projectId, title, status: todo | doing | done, assignee }`

**Key rules (all proven by a real end-to-end deploy):**

1. **Service code MUST live under `services/<name>/`, not the repo/template
   root.** `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
   The service named `web` → the CLI looks for `services/web/`. App files at the
   root fail with `Error: Service directory not found: …/services/web`.
2. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as the `DATABASE_MONGODB_URL` environment
   variable (plus the legacy `MONGODB_URL` alias) at dev-time and runtime; the
   app reads `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside
   `getDb`. A top-level read fails `next build` (the module is imported for route
   analysis before the grid injects the var). Never hardcode a connection string;
   never commit a secret.
3. **Declare the datastore with `needs: { database: true }`.** This is the
   canonical shape — the deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). `requires:` is
   the deprecated v1 alias; don't author new yaml with it, and never set `needs:`
   and `requires:` together (the validator rejects the combination).

Write these files into the scaffolded app folder — the app code goes under
`services/web/` — adapt the collections/fields to the user's app, then `grid dev`
(local) / `grid plug` (deploy, async — poll to a live URL).

## File tree

```
cloudgrid.yaml                             # name + services.web (nextjs) + needs: { database: true }
services/web/package.json                  # next, react, react-dom, mongodb driver only
services/web/lib/db.js                     # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js                 # root layout + inline CSS
services/web/app/page.js                   # server component: reads projects + tasks from Mongo
services/web/app/board.js                  # client component: project list + task board (POST/PATCH/DELETE)
services/web/app/api/projects/route.js     # GET (list) / POST (add) / DELETE (remove + cascade tasks)
services/web/app/api/tasks/route.js        # GET (list by project) / POST (add) / PATCH (move status) / DELETE
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-project-board
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** this template's need is `database: true`. The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias), so an app reading either var works. `requires:` is the
> deprecated v1 alias — don't mix it with `needs:` (the validator rejects the
> combination). See the capability-map for the full injection table.

## services/web/package.json

```json
{
  "name": "my-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "mongodb": "^6.12.0"
  }
}
```

## services/web/lib/db.js

```js
// Cached MongoDB client. The grid injects DATABASE_MONGODB_URL (legacy MONGODB_URL
// alias) at dev-time and runtime. Read it LAZILY inside getDb — a top-level read
// fails `next build`. Never hardcode a connection string; never commit a secret.
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) {
    throw new Error(
      "DATABASE_MONGODB_URL is not set. The grid injects it automatically — run " +
        "this app with `grid dev` locally, or deploy it with `grid plug`.",
    );
  }
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  const client = await clientPromise();
  return client.db();
}
```

## services/web/app/layout.js

```js
export const metadata = {
  title: "Projects",
  description: "A team project & task board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, sans-serif; }
  main { max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  .row { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; cursor: pointer; }
  .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  .col { border: 1px solid #8883; border-radius: .75rem; padding: .75rem; }
  .card { border: 1px solid #8884; border-radius: .5rem; padding: .5rem .6rem; margin-bottom: .5rem; }
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head><style dangerouslySetInnerHTML={{ __html: css }} /></head>
      <body>{children}</body>
    </html>
  );
}
```

## services/web/app/page.js

```js
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
  const items = await db.collection("tasks").find({ projectId }).sort({ createdAt: -1 }).toArray();
  return items.map((t) => ({
    id: t._id.toString(), projectId: t.projectId, title: t.title,
    status: t.status, assignee: t.assignee || "",
  }));
}

export default async function Page({ searchParams }) {
  const projects = await listProjects();
  const sp = await searchParams;
  const selectedId =
    (sp && sp.project && projects.some((p) => p.id === sp.project) && sp.project) ||
    (projects[0] && projects[0].id) || null;
  const tasks = selectedId ? await listTasks(selectedId) : [];
  return (
    <main>
      <h1>Projects</h1>
      <Board initialProjects={projects} initialSelectedId={selectedId} initialTasks={tasks} />
    </main>
  );
}
```

## services/web/app/board.js

```js
"use client";
import { useState } from "react";

const STATUSES = ["todo", "doing", "done"];
const LABELS = { todo: "To do", doing: "Doing", done: "Done" };

export default function Board({ initialProjects, initialSelectedId, initialTasks }) {
  const [projects, setProjects] = useState(initialProjects);
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [tasks, setTasks] = useState(initialTasks);
  const [projectName, setProjectName] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");

  async function loadTasks(projectId) {
    const res = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}`);
    setTasks(res.ok ? await res.json() : []);
  }
  async function selectProject(id) { setSelectedId(id); await loadTasks(id); }

  async function addProject(e) {
    e.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const p = await res.json();
      setProjects((prev) => [p, ...prev]); setProjectName(""); setSelectedId(p.id); setTasks([]);
    }
  }
  async function addTask(e) {
    e.preventDefault();
    const title = taskTitle.trim();
    if (!title || !selectedId) return;
    const res = await fetch("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: selectedId, title, assignee: taskAssignee.trim() }),
    });
    if (res.ok) { setTasks((prev) => [await res.json(), ...prev]); setTaskTitle(""); setTaskAssignee(""); }
  }
  async function moveTask(id, status) {
    const res = await fetch(`/api/tasks?id=${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  }

  // ...render project list + three status columns, each card offering
  // move-to-other-status and delete. Full source in services/web/app/board.js.
}
```

## services/web/app/api/projects/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

async function projects() { const db = await getDb(); return db.collection("projects"); }

export async function GET() {
  const col = await projects();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map((p) => ({ id: p._id.toString(), name: p.name })));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const col = await projects();
  const res = await col.insertOne({ name, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), name }, { status: 201 });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const db = await getDb();
  await db.collection("projects").deleteOne({ _id: new ObjectId(id) });
  await db.collection("tasks").deleteMany({ projectId: id });   // cascade
  return NextResponse.json({ ok: true });
}
```

## services/web/app/api/tasks/route.js

```js
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

export const dynamic = "force-dynamic";
const STATUSES = ["todo", "doing", "done"];

async function tasks() { const db = await getDb(); return db.collection("tasks"); }
const shape = (t) => ({
  id: t._id.toString(), projectId: t.projectId, title: t.title,
  status: t.status, assignee: t.assignee || "",
});

export async function GET(request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const col = await tasks();
  const items = await col.find({ projectId }).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
  const status = STATUSES.includes(body.status) ? body.status : "todo";
  if (!projectId || !ObjectId.isValid(projectId)) return NextResponse.json({ error: "valid projectId is required" }, { status: 400 });
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  const col = await tasks();
  const doc = { projectId, title, status, assignee, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ ...doc, _id: res.insertedId }), { status: 201 });
}

export async function PATCH(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  if (!STATUSES.includes(body.status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
  const col = await tasks();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { status: body.status } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  const col = await tasks();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
```

## Adapt it

- Rename the `projects` / `tasks` collections; change document fields (due dates,
  priorities, labels).
- Add more statuses (edit `STATUSES` in `board.js` and the tasks route validation).
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
