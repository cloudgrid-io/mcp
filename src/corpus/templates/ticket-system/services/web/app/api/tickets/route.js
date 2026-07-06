// App Router route handler for the `tickets` collection.
// GET -> list tickets, POST -> add a ticket, PATCH -> change status,
// DELETE -> remove a ticket by id.
//
// To adapt this app, rename the collection and change the fields to match your
// own data (e.g. an `issues` or `requests` collection).
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STATUSES = ["open", "pending", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

async function tickets() {
  const db = await getDb();
  return db.collection("tickets");
}

function shape(t) {
  return {
    id: t._id.toString(),
    subject: t.subject || "",
    requester: t.requester || "",
    status: STATUSES.includes(t.status) ? t.status : "open",
    priority: PRIORITIES.includes(t.priority) ? t.priority : "normal",
    body: t.body || "",
  };
}

// GET /api/tickets — list all tickets, newest first.
export async function GET() {
  const col = await tickets();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/tickets — add a ticket. Body: { subject, requester, status, priority, body }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject) {
    return NextResponse.json({ error: "subject is required" }, { status: 400 });
  }
  const doc = {
    subject,
    requester: typeof body.requester === "string" ? body.requester.trim() : "",
    status: STATUSES.includes(body.status) ? body.status : "open",
    priority: PRIORITIES.includes(body.priority) ? body.priority : "normal",
    body: typeof body.body === "string" ? body.body.trim() : "",
    createdAt: new Date(),
  };
  const col = await tickets();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// PATCH /api/tickets — change a ticket's status. Body: { id, status }.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const { id, status } = body;
  if (!id || !ObjectId.isValid(id) || !STATUSES.includes(status)) {
    return NextResponse.json({ error: "valid id and status required" }, { status: 400 });
  }
  const col = await tickets();
  await col.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
  return NextResponse.json({ ok: true });
}

// DELETE /api/tickets?id=<id> — remove a ticket.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await tickets();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
