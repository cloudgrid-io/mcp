// App Router route handler for the `entries` collection.
// GET  -> list entries, POST -> add an entry, DELETE -> remove an entry by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `timesheets` or `sessions` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function entries() {
  const db = await getDb();
  return db.collection("entries");
}

// GET /api/entries — list all entries, newest first.
export async function GET() {
  const col = await entries();
  const items = await col.find({}).sort({ date: -1, createdAt: -1 }).toArray();
  return NextResponse.json(
    items.map((e) => ({
      id: e._id.toString(),
      task: e.task,
      project: e.project,
      minutes: e.minutes,
      date: e.date,
    })),
  );
}

// POST /api/entries — add an entry. Body: { task, project, minutes:number, date }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const minutes = Number.isFinite(body.minutes) ? Math.trunc(body.minutes) : NaN;
  const date =
    typeof body.date === "string" && body.date.trim()
      ? body.date.trim()
      : new Date().toISOString().slice(0, 10);
  if (!task || !project || !Number.isFinite(minutes) || minutes <= 0) {
    return NextResponse.json(
      { error: "task, project and a positive minutes value are required" },
      { status: 400 },
    );
  }
  const col = await entries();
  const res = await col.insertOne({ task, project, minutes, date, createdAt: new Date() });
  return NextResponse.json(
    { id: res.insertedId.toString(), task, project, minutes, date },
    { status: 201 },
  );
}

// DELETE /api/entries?id=<id> — remove an entry.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await entries();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
