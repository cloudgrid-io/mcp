// App Router route handler for the `requests` collection (API request log).
// GET  -> list recent requests, POST -> record a request, DELETE -> remove one.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. an `events` or `calls` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function requests() {
  const db = await getDb();
  return db.collection("requests");
}

function serialize(r) {
  return {
    id: r._id.toString(),
    endpoint: r.endpoint,
    status: r.status,
    ms: r.ms,
    at: r.at instanceof Date ? r.at.toISOString() : r.at,
  };
}

// GET /api/requests — list recent requests, newest first.
export async function GET() {
  const col = await requests();
  const items = await col.find({}).sort({ at: -1 }).limit(50).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/requests — record a request. Body: { endpoint, status, ms }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }
  const status = Number.isFinite(Number(body.status)) ? Number(body.status) : 200;
  const ms = Number.isFinite(Number(body.ms)) ? Math.max(0, Number(body.ms)) : 0;
  const at = new Date();
  const col = await requests();
  const res = await col.insertOne({ endpoint, status, ms, at });
  return NextResponse.json(
    { id: res.insertedId.toString(), endpoint, status, ms, at: at.toISOString() },
    { status: 201 },
  );
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
