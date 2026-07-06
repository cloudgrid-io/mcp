// App Router route handler for the `orders` collection.
// GET -> list orders, POST -> add an order, DELETE -> remove an order by id.
//
// This is the second of two generic admin resources (see also api/users). To
// adapt, rename the collection or change the fields.
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "../../../lib/db.js";

// Never cache — always read/write live data.
export const dynamic = "force-dynamic";

const STATUSES = ["pending", "paid", "shipped"];

async function orders() {
  const db = await getDb();
  return db.collection("orders");
}

function shape(o) {
  return {
    id: o._id.toString(),
    customer: o.customer || "",
    amount: typeof o.amount === "number" ? o.amount : 0,
    status: STATUSES.includes(o.status) ? o.status : "pending",
  };
}

// GET /api/orders — list all orders, newest first.
export async function GET() {
  const col = await orders();
  const items = await col.find({}).sort({ createdAt: -1 }).toArray();
  return NextResponse.json(items.map(shape));
}

// POST /api/orders — add an order. Body: { customer, amount, status }.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const customer = typeof body.customer === "string" ? body.customer.trim() : "";
  if (!customer) {
    return NextResponse.json({ error: "customer is required" }, { status: 400 });
  }
  const amount = Number(body.amount);
  const doc = {
    customer,
    amount: Number.isFinite(amount) ? amount : 0,
    status: STATUSES.includes(body.status) ? body.status : "pending",
    createdAt: new Date(),
  };
  const col = await orders();
  const res = await col.insertOne(doc);
  return NextResponse.json({ id: res.insertedId.toString(), ...doc }, { status: 201 });
}

// DELETE /api/orders?id=<id> — remove an order.
export async function DELETE(request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !ObjectId.isValid(id)) {
    return NextResponse.json({ error: "valid id is required" }, { status: 400 });
  }
  const col = await orders();
  await col.deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
