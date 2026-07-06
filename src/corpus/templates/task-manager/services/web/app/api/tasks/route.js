// App Router route handler for the `tasks` collection.
// GET -> list tasks, POST -> add a task, PATCH -> toggle done, DELETE -> remove
// a task by id.
//
// To adapt this app, rename the collection or change the fields.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const PRIORITIES = ["low", "medium", "high"];

async function tasks() {
  const db = await getDb();
  return db.collection("tasks");
}

function shape(t) {
  return {
    id: t._id.toString(),
    title: t.title || "",
    done: !!t.done,
    due: t.due || "",
    priority: PRIORITIES.includes(t.priority) ? t.priority : "medium",
  };
}

// GET /api/tasks — list all tasks, newest first.
export async function GET() {
  const col = await tasks();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/tasks — add a task. Body: { title, due, priority }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const doc = {
    title,
    done: false,
    due: typeof body.due === "string" ? body.due.trim() : "",
    priority: PRIORITIES.includes(body.priority) ? body.priority : "medium",
    createdAt: new Date(),
  };
  const col = await tasks();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/tasks — toggle a task's done state. Body: { id, done }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, done } = body;
  if (!id || !ObjectId.isValid(id) || typeof done !== "boolean") {
    return NextResponse.json({ error: "valid id and done (boolean) required" }, { status: 400 });
  }
  const col = await tasks();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { done } });
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
