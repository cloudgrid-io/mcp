// App Router route handler for the `jobs` collection.
// GET -> list jobs (public), POST -> post a job, DELETE -> remove a job by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. a `gigs` or `roles` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

async function jobs() {
  const db = await getDb();
  return db.collection("jobs");
}

function shape(j) {
  return {
    id: j._id.toString(),
    title: j.title || "",
    company: j.company || "",
    location: j.location || "",
    type: j.type || "",
    url: j.url || "",
  };
}

// GET /api/jobs — list all open roles, newest first.
export async function GET() {
  const col = await jobs();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/jobs — post a job. Body: { title, company, location, type, url }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  if (!title || !company) {
    return NextResponse.json({ error: "title and company are required" }, { status: 400 });
  }
  const doc = {
    title,
    company,
    location: typeof body.location === "string" ? body.location.trim() : "",
    type: typeof body.type === "string" ? body.type.trim() : "",
    url: typeof body.url === "string" ? body.url.trim() : "",
    createdAt: new Date(),
  };
  const col = await jobs();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// DELETE /api/jobs?id=<id> — remove a job.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await jobs();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
