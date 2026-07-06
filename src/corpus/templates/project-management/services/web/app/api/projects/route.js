// App Router route handler for the `projects` collection.
// GET -> list projects, POST -> add a project, DELETE -> remove a project (and its tasks).
//
// To adapt this app, rename the collection and change the fields to match your
// own data.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function projects() {
  const db = await getDb();
  return db.collection("projects");
}

// GET /api/projects — list all projects, newest first.
export async function GET() {
  const col = await projects();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map((p) => ({ id: p._id.toString(), name: p.name })));
}

// POST /api/projects — add a project. Body: { name: string }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const col = await projects();
  const res = await col.insertOne({ name, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), name }, { status: 201 });
}

// DELETE /api/projects?id=<id> — remove a project and all of its tasks.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const db = await getDb();
  await db.collection("projects").deleteOne({ _id: new ObjectId(id) });
  // Cascade: drop the project's tasks too (tasks store projectId as a string).
  await db.collection("tasks").deleteMany({ projectId: id });
  return NextResponse.json({ ok: true });
}
