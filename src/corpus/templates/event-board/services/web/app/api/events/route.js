// App Router route handler for the `events` collection.
// GET  -> list events (upcoming: sorted by date ascending),
// POST -> add an event, DELETE -> remove an event by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `meetups` or `sessions` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function events() {
  const db = await getDb();
  return db.collection("events");
}

function shape(e) {
  return {
    id: e._id.toString(),
    title: e.title,
    date: e.date,
    location: e.location,
    description: e.description,
  };
}

// GET /api/events — list all events, soonest date first (upcoming board).
export async function GET() {
  const col = await events();
  const items = await col.find({}).sort({ date: 1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/events — add an event. Body: { title, date, location?, description? }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!title || !date) {
    return NextResponse.json({ error: "title and date are required" }, { status: 400 });
  }
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const col = await events();
  const doc = { title, date, location, description, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), title, date, location, description }, { status: 201 });
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
