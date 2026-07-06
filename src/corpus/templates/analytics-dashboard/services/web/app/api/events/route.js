// App Router route handler for the `events` collection.
// GET  -> list recent events, POST -> record an event, DELETE -> remove one by id.
//
// An event is { type: string, value: number, at: Date }. To adapt this app,
// rename the collection and change the fields to match your own metrics.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function events() {
  const db = await getDb();
  return db.collection("events");
}

function serialize(e) {
  return {
    id: e._id.toString(),
    type: e.type,
    value: typeof e.value === "number" ? e.value : 0,
    at: (e.at instanceof Date ? e.at : new Date(e.at)).toISOString(),
  };
}

// GET /api/events — list recent events, newest first.
export async function GET() {
  const col = await events();
  const items = await col.find({}).sort({ at: -1 }).limit(50).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/events — record an event. Body: { type: string, value?: number }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!type) {
    return NextResponse.json({ error: "type is required" }, { status: 400 });
  }
  const value = Number.isFinite(Number(body.value)) ? Number(body.value) : 1;
  const at = new Date();
  const col = await events();
  const res = await col.insertOne({ type, value, at });
  return NextResponse.json(
    { id: res.insertedId.toString(), type, value, at: at.toISOString() },
    { status: 201 },
  );
}

// DELETE /api/events?id=<id> — remove an event.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await events();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
