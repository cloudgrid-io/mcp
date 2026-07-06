// App Router route handler for the `entries` collection.
// GET  -> list entries, POST -> add an entry, DELETE -> remove an entry by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own listings (e.g. a `members` or `businesses` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function entries() {
  const db = await getDb();
  return db.collection("entries");
}

function serialize(e) {
  return {
    id: e._id.toString(),
    name: e.name,
    category: e.category || "",
    url: e.url || "",
    description: e.description || "",
  };
}

// GET /api/entries — list all entries, newest first.
export async function GET() {
  const col = await entries();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/entries — add an entry. Body: { name, category, url, description }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const doc = {
    name,
    category: typeof body.category === "string" ? body.category.trim() : "",
    url: typeof body.url === "string" ? body.url.trim() : "",
    description: typeof body.description === "string" ? body.description.trim() : "",
    createdAt: new Date(),
  };
  const col = await entries();
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
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
