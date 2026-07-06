// App Router route handler for the `requests` collection.
// GET    -> list requests (votes desc), POST -> add a request,
// PATCH  -> upvote a request (atomic increment), DELETE -> remove a request by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STATUSES = ["open", "planned", "done"];

async function requests() {
  const db = await getDb();
  return db.collection("requests");
}

function shape(r) {
  return {
    id: r._id.toString(),
    title: r.title,
    description: r.description || "",
    votes: r.votes || 0,
    status: r.status || "open",
  };
}

// GET /api/requests — list all requests, most-voted first.
export async function GET() {
  const col = await requests();
  const items = await col.find({}).sort({ votes: -1, createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/requests — add a request. Body: { title, description?, status? }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const status = STATUSES.includes(body.status) ? body.status : "open";
  const col = await requests();
  const doc = { title, description, votes: 0, status, createdAt: new Date() };
  const res = await col.insertOne(doc);
  return NextResponse.json(shape({ ...doc, _id: res.insertedId }), { status: 201 });
}

// PATCH /api/requests?id=<id> — upvote (atomic $inc) or set status.
// Body: { vote?: number, status?: "open"|"planned"|"done" }.
export async function PATCH(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  const update = {};
  if (typeof body.vote === "number") {
    update.$inc = { votes: body.vote };
  }
  if (STATUSES.includes(body.status)) {
    update.$set = { status: body.status };
  }
  if (!update.$inc && !update.$set) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  const col = await requests();
  const doc = await col.findOneAndUpdate(
    { _id: new ObjectId(id) },
    update,
    { returnDocument: "after" },
  );
  if (!doc) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(shape(doc));
}

// DELETE /api/requests?id=<id> — remove a request.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await requests();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
