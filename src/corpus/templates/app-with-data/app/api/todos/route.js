// App Router route handler for the `todos` collection.
// GET  -> list todos, POST -> add a todo, DELETE -> remove a todo by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `submissions` or `tasks` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function todos() {
  const db = await getDb();
  return db.collection("todos");
}

// GET /api/todos — list all todos, newest first.
export async function GET() {
  const col = await todos();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(
    items.map((t) => ({ id: t._id.toString(), text: t.text, done: !!t.done })),
  );
}

// POST /api/todos — add a todo. Body: { text: string }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const col = await todos();
  const res = await col.insertOne({ text, done: false, createdAt: new Date() });
  return NextResponse.json({ id: res.insertedId.toString(), text, done: false }, { status: 201 });
}

// DELETE /api/todos?id=<id> — remove a todo.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await todos();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
