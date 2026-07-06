// App Router route handler for the `checks` collection.
// GET  -> list recent checks, POST -> record a check, DELETE -> remove a check by id.
//
// A check is a health sample: { service, status(up/down/degraded), latencyMs, at }.
// To adapt this app, rename the collection and change the fields to match your
// own monitoring data.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STATUSES = ["up", "degraded", "down"];

async function checks() {
  const db = await getDb();
  return db.collection("checks");
}

function serialize(c) {
  return {
    id: c._id.toString(),
    service: c.service,
    status: c.status,
    latencyMs: c.latencyMs,
    at: (c.at instanceof Date ? c.at : new Date(c.at)).toISOString(),
  };
}

// GET /api/checks — list recent checks, newest first.
export async function GET() {
  const col = await checks();
  const items = await col.find({}).sort({ at: -1 }).limit(200).toArray();
  return NextResponse.json(items.map(serialize));
}

// POST /api/checks — record a check. Body: { service, status, latencyMs? }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const service = typeof body.service === "string" ? body.service.trim() : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!service) {
    return NextResponse.json({ error: "service is required" }, { status: 400 });
  }
  if (!STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  let latencyMs;
  if (body.latencyMs !== undefined && body.latencyMs !== null && body.latencyMs !== "") {
    const n = Number(body.latencyMs);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "latencyMs must be a non-negative number" }, { status: 400 });
    }
    latencyMs = n;
  }
  const doc = { service, status, at: new Date() };
  if (latencyMs !== undefined) doc.latencyMs = latencyMs;
  const col = await checks();
  const res = await col.insertOne(doc);
  return NextResponse.json(serialize({ _id: res.insertedId, ...doc }), { status: 201 });
}

// DELETE /api/checks?id=<id> — remove a check.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await checks();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
