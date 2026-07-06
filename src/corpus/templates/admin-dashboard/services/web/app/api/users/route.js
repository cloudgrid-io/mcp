// App Router route handler for the `users` collection.
// GET -> list users, POST -> add a user, DELETE -> remove a user by id.
//
// This is one of two generic admin resources (see also api/orders). To adapt,
// rename the collection or change the fields.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const ROLES = ["admin", "member", "viewer"];

async function users() {
  const db = await getDb();
  return db.collection("users");
}

function shape(u) {
  return {
    id: u._id.toString(),
    name: u.name || "",
    email: u.email || "",
    role: ROLES.includes(u.role) ? u.role : "member",
  };
}

// GET /api/users — list all users, newest first.
export async function GET() {
  const col = await users();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/users — add a user. Body: { name, email, role }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const doc = {
    name,
    email: typeof body.email === "string" ? body.email.trim() : "",
    role: ROLES.includes(body.role) ? body.role : "member",
    createdAt: new Date(),
  };
  const col = await users();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// DELETE /api/users?id=<id> — remove a user.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await users();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
