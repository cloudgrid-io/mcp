// App Router route handler for the `tasks` collection.
// GET    -> list tasks for a project, POST -> add a task,
// PATCH  -> change a task's status, DELETE -> remove a task.
//
// A task document: { projectId: string, title: string, status: "todo"|"doing"|"done",
// assignee: string, createdAt: Date }.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STATUSES = ["todo", "doing", "done"];

async function tasks() {
  const db = await getDb();
  return db.collection("tasks");
}

function shape(t) {
  return {
    id: t._id.toString(),
    projectId: t.projectId,
    title: t.title,
    status: t.status,
    assignee: t.assignee || "",
  };
}

// GET /api/tasks?projectId=<id> — list a project's tasks, newest first.
export async function GET(request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  const col = await tasks();
  const items = await col.find({ projectId }).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/tasks — add a task. Body: { projectId, title, assignee?, status? }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
  const status = STATUSES.includes(body.status) ? body.status : "todo";
  if (!projectId || !ObjectId.isValid(projectId)) {
    return NextResponse.json({ error: "valid projectId is required" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const col = await tasks();
  const doc = { projectId, title, status, assignee, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ ...doc, _id: res.insertedId }), { status: 201 });
}

// PATCH /api/tasks?id=<id> — change a task's status. Body: { status }.
export async function PATCH(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  if (!STATUSES.includes(body.status)) {
    return NextResponse.json({ error: "status must be todo, doing, or done" }, { status: 400 });
  }
  const col = await tasks();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { status: body.status } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/tasks?id=<id> — remove a task.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await tasks();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
